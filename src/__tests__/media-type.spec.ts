/**
 * The one classification of a media type shared by generation
 * (`ParameterResolver`) and request assembly (`buildHttpRequest`).
 */
import { FORM_URLENCODED, JSON_MEDIA_TYPE, classifyMediaType, isMediaRange, mediaTypeEssence, mediaTypeList } from '../media-type';

describe('mediaTypeEssence', () => {
  it('drops the parameters, the surrounding space and the case', () => {
    expect(mediaTypeEssence('application/json')).toBe('application/json');
    expect(mediaTypeEssence('Application/JSON; charset=utf-8')).toBe('application/json');
    expect(mediaTypeEssence('  text/plain ;charset=x;y=z ')).toBe('text/plain');
    expect(mediaTypeEssence('application/x-www-form-urlencoded;charset=utf-8')).toBe(FORM_URLENCODED);
  });

  it('is an empty string for a media type that has none', () => {
    expect(mediaTypeEssence('')).toBe('');
    expect(mediaTypeEssence('   ')).toBe('');
    expect(mediaTypeEssence('; charset=utf-8')).toBe('');
  });
});

describe('classifyMediaType', () => {
  it.each([
    ['application/json', 'json'],
    ['application/json; charset=utf-8', 'json'],
    ['Application/JSON', 'json'],
    [' application/json ', 'json'],
    ['application/problem+json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['APPLICATION/HAL+JSON; profile=x', 'json'],
    ['application/x-www-form-urlencoded', 'form'],
    ['application/x-www-form-urlencoded; charset=utf-8', 'form'],
    ['Application/X-WWW-Form-Urlencoded', 'form'],
    ['text/json', 'other'],
    ['text/foo+json', 'other'],
    ['text/plain', 'other'],
    ['application/xml', 'other'],
    ['multipart/form-data', 'other'],
    ['application/jsonl', 'other'],
    ['application/json-seq', 'other'],
    ['application/x-ndjson', 'other'],
    ['application/+json', 'other'],
    ['application/json+x', 'other'],
    ['application/x-www-form-urlencoded-x', 'other'],
    ['json', 'other'],
    ['', 'other'],
    ['   ', 'other'],
    ['; charset=utf-8', 'other'],
  ])('reads %j as %s', (mediaType, expected) => {
    expect(classifyMediaType(mediaType)).toBe(expected);
  });

  it.each([[undefined], [null], [42], [true], [{}], [['application/json']], [Symbol('application/json')]])(
    'reads %p, which is not a string, as other',
    (value) => {
      expect(classifyMediaType(value)).toBe('other');
    },
  );

  it('reads a string object, which is not a string either, as other', () => {
    // eslint-disable-next-line no-new-wrappers
    expect(classifyMediaType(new String('application/json'))).toBe('other');
  });
});

describe('JSON_MEDIA_TYPE', () => {
  it('matches a whole string, so a body Content-Type with parameters is not matched as written', () => {
    expect(JSON_MEDIA_TYPE.test('application/json')).toBe(true);
    expect(JSON_MEDIA_TYPE.test('Application/Vnd.Api+JSON')).toBe(true);
    expect(JSON_MEDIA_TYPE.test('application/json; charset=utf-8')).toBe(false);
    expect(JSON_MEDIA_TYPE.test('text/json')).toBe(false);
  });

  it('keeps no state between tests', () => {
    expect(JSON_MEDIA_TYPE.global).toBe(false);
    expect(JSON_MEDIA_TYPE.sticky).toBe(false);
  });
});

describe('mediaTypeList (an Encoding Object contentType)', () => {
  it.each([
    ['image/png', ['image/png']],
    ['image/png, image/jpeg', ['image/png', 'image/jpeg']],
    ['image/png,image/jpeg ,  image/*', ['image/png', 'image/jpeg', 'image/*']],
    ['application/xml; charset=utf-8, text/plain', ['application/xml; charset=utf-8', 'text/plain']],
    ['text/plain; x="a,b", text/csv', ['text/plain; x="a,b"', 'text/csv']],
    ['text/plain; x="a\\",b", text/csv', ['text/plain; x="a\\",b"', 'text/csv']],
    [' , ,image/png,', ['image/png']],
    ['', []],
    ['  ', []],
  ])('reads %j as %j', (contentType, expected) => {
    expect(mediaTypeList(contentType)).toEqual(expected);
  });
});

describe('isMediaRange', () => {
  it.each([
    ['image/*', true],
    ['*/*', true],
    ['*/*; q=0.5', true],
    ['image', true],
    ['image/', true],
    ['', true],
    ['image/png', false],
    ['Application/JSON; charset=utf-8', false],
    ['application/vnd.api+json', false],
  ])('reads %j as a range: %s', (mediaType, expected) => {
    expect(isMediaRange(mediaType)).toBe(expected);
  });
});
