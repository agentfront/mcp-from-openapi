/**
 * Base error class for all library errors
 */
export class OpenAPIToolError extends Error {
  public readonly context?: Record<string, any>;

  constructor(message: string, context?: Record<string, any>) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;

    // captureStackTrace is Node.js-specific, guard against non-Node environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when loading an OpenAPI specification fails
 */
export class LoadError extends OpenAPIToolError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
  }
}

/**
 * Error thrown when a spec URL or external `$ref` target is refused by the
 * SSRF guard: it targets — or resolves to — a loopback / private / link-local /
 * cloud-metadata address, uses a disallowed protocol, or is outside the
 * configured allow-list.
 *
 * Subclasses {@link LoadError} so it propagates cleanly out of `fromURL` (whose
 * catch re-throws `LoadError`) and so existing `instanceof LoadError` handling
 * keeps working, while still being independently catchable.
 */
export class SsrfError extends LoadError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
  }
}

/**
 * Error thrown when parsing an OpenAPI specification fails
 */
export class ParseError extends OpenAPIToolError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
  }
}

/**
 * Error thrown when validating an OpenAPI specification fails
 */
export class ValidationError extends OpenAPIToolError {
  public readonly errors?: any[];

  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
    this.errors = context?.['errors'];
  }
}

/**
 * Error thrown when generating a tool fails
 */
export class GenerationError extends OpenAPIToolError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
  }
}

/**
 * Error thrown when an OpenAPI Overlay document is malformed or its JSONPath
 * target uses unsupported syntax
 */
export class OverlayError extends OpenAPIToolError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
  }
}

/**
 * Error thrown when an HTTP request cannot be built from a tool's mapper
 * (missing required parameters, unserializable values, injection attempts)
 */
export class RequestBuildError extends OpenAPIToolError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
  }
}

/**
 * Error thrown when an Arazzo document is malformed or cannot be resolved
 * against its sources. `path` is a JSON Pointer into the Arazzo document.
 */
export class ArazzoError extends OpenAPIToolError {
  public readonly path?: string;

  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
    this.path = context?.['path'];
  }
}

/**
 * Error thrown when a schema is invalid
 */
export class SchemaError extends OpenAPIToolError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, context);
  }
}
