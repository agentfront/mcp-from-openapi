/** Tests for the dottedNaming preset */
import { dottedNaming, CODECALL_RESERVED_NAMESPACES } from '../naming-presets';
import { OpenAPIToolGenerator } from '../generator';
import type { HTTPMethod, OperationObject } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HALF = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const nameFor = (
  path: string,
  method: HTTPMethod,
  operationId?: string,
  operation?: Partial<OperationObject>,
  options?: any,
): string => dottedNaming(options).toolNameGenerator!(path, method, operationId, operation as OperationObject);

const expectBindable = (name: string): void => {
  const dot = name.indexOf('.');
  expect(dot).toBeGreaterThan(0);
  expect(HALF.test(name.slice(0, dot))).toBe(true);
  expect(HALF.test(name.slice(dot + 1))).toBe(true);
};

describe('dottedNaming', () => {
  it('namespaces by first tag with the operationId as the method half', () => {
    const name = nameFor('/invoices', 'get', 'listInvoices', { tags: ['billing', 'other'] });
    expect(name).toBe('billing.listInvoices');
    expectBindable(name);
  });

  it('sanitizes tags and operationIds into identifiers', () => {
    expect(nameFor('/x', 'get', 'get-user.by id', { tags: ['User Management'] })).toBe('User_Management.get_user_by_id');
    expect(nameFor('/x', 'get', 'weird!!')).toBe('x.weird');
  });

  it('letter-guards digit-leading namespaces so normalization cannot strip the guard', () => {
    expect(nameFor('/x', 'get', undefined, { tags: ['3rd-party'] })).toBe('n3rd_party.get_x');
    expect(nameFor('/x', 'get', 'op', { tags: ['42'] })).toBe('n42.op');
    expect(nameFor('/2fa/enable', 'post', undefined)).toBe('n2fa.post__2fa_enable');
  });

  it('falls back to the first path segment, then to api', () => {
    expect(nameFor('/users/{id}', 'get', 'getUser')).toBe('users.getUser');
    expect(nameFor('/users/{id}', 'get', 'getUser', { tags: [] })).toBe('users.getUser');
    expect(nameFor('/{id}', 'get', 'lookup')).toBe('api.lookup');
    expect(nameFor('/', 'get', 'root')).toBe('api.root');
  });

  it('uses the first path segment directly when namespaceFrom is firstPathSegment', () => {
    expect(nameFor('/users/{id}', 'get', 'getUser', { tags: ['billing'] }, { namespaceFrom: 'firstPathSegment' })).toBe(
      'users.getUser',
    );
  });

  it('suffixes reserved namespaces with an underscore', () => {
    expect(nameFor('/x', 'get', 'log', { tags: ['console'] })).toBe('console_.log');
    expect(nameFor('/x', 'get', 'op', { tags: ['mine'] }, { reservedNamespaces: ['mine'] })).toBe('mine_.op');
    expect(nameFor('/x', 'get', 'op', { tags: ['global'] })).toBe('global_.op');
    // mirror CodeCall's real reserved list
    for (const ns of ['callTool', 'WeakMap', 'WeakSet', 'global', 'window', 'self', 'null', 'true', 'false']) {
      expect(CODECALL_RESERVED_NAMESPACES).toContain(ns);
    }
  });

  it('derives the method half from method and path when there is no operationId', () => {
    expect(nameFor('/users/{id}/posts', 'get', undefined)).toBe('users.get_by_id_posts');
    expect(nameFor('/users', 'delete', undefined)).toBe('users.delete');
    expect(nameFor('/users', 'delete', undefined, { tags: ['admin'] })).toBe('admin.delete_users');
  });

  it('produces bindable two-segment names across shapes', () => {
    const cases: Array<[string, HTTPMethod, string | undefined, Partial<OperationObject> | undefined]> = [
      ['/a-b/{c}', 'post', undefined, undefined],
      ['/x', 'get', '...', { tags: ['...'] }],
      ['/{v}/{w}', 'put', undefined, { tags: ['T-1'] }],
    ];
    for (const [path, method, opId, op] of cases) {
      expectBindable(nameFor(path, method, opId, op));
    }
  });
});

describe('dottedNaming end-to-end through generateTools', () => {
  const spec: any = {
    openapi: '3.0.0',
    info: { title: 'Dotted API', version: '1.0.0' },
    paths: {
      '/invoices': {
        get: { operationId: 'listInvoices', tags: ['billing'], responses: { '200': { description: 'OK' } } },
      },
      '/invoices/{id}': {
        get: {
          operationId: 'getInvoice',
          tags: ['billing'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/dup': { get: { operationId: 'same', tags: ['ns'], responses: { '200': { description: 'OK' } } } },
      '/dup2': { get: { operationId: 'same', tags: ['ns'], responses: { '200': { description: 'OK' } } } },
    },
  };

  it('emits dotted names and keeps dedup suffixes namespace-parseable', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tools = await generator.generateTools({ namingStrategy: dottedNaming() });
    const names = tools.map((t) => t.name);

    expect(names).toContain('billing.listInvoices');
    expect(names).toContain('billing.getInvoice');
    expect(names).toContain('ns.same');
    const deduped = names.find((n) => /^ns\.same_[0-9a-f]{8}$/.test(n));
    expect(deduped).toBeDefined();
    const dot = deduped!.indexOf('.');
    expect(HALF.test(deduped!.slice(dot + 1))).toBe(true);
  });

  it('keeps digit-leading namespaces bindable through generateTools normalization', async () => {
    const digitSpec: any = {
      openapi: '3.0.0',
      info: { title: 'Digit API', version: '1.0.0' },
      paths: {
        '/things': { get: { operationId: 'opA', tags: ['3rd-party'], responses: { '200': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(digitSpec, { validate: false });
    const tools = await generator.generateTools({ namingStrategy: dottedNaming() });
    expect(tools[0].name).toBe('n3rd_party.opA');
    expectBindable(tools[0].name);
  });

  it('preserves this binding for class-based conflict resolvers', async () => {
    class MyStrategy {
      prefix = 'X';
      helper(name: string, index: number): string {
        return `${this.prefix}${index}_${name}`;
      }
      conflictResolver = function (this: MyStrategy, paramName: string, _location: unknown, index: number): string {
        return this.helper(paramName, index);
      };
    }
    const conflictSpec: any = {
      openapi: '3.0.0',
      info: { title: 'Conflict API', version: '1.0.0' },
      paths: {
        '/things/{name}': {
          get: {
            operationId: 'getThing',
            parameters: [
              { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'name', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(conflictSpec, { validate: false });
    const tool = await generator.generateTool('/things/{name}', 'get', { namingStrategy: new MyStrategy() as any });
    const keys = Object.keys((tool.inputSchema as any).properties);
    expect(keys).toContain('X0_name');
    expect(keys).toContain('X1_name');
  });

  it('resolves parameter conflicts via the default resolver when the strategy has none', async () => {
    const conflictSpec: any = {
      openapi: '3.0.0',
      info: { title: 'Conflict API', version: '1.0.0' },
      paths: {
        '/things/{name}': {
          get: {
            operationId: 'getThing',
            tags: ['things'],
            parameters: [
              { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'name', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(conflictSpec, { validate: false });
    const tool = await generator.generateTool('/things/{name}', 'get', { namingStrategy: dottedNaming() });

    expect(tool.name).toBe('things.getThing');
    const keys = Object.keys((tool.inputSchema as any).properties);
    expect(keys).toContain('pathName');
    expect(keys).toContain('queryName');
  });
});
