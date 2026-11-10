// 工具参数模式使用受控子集，由 Kernel 负责校验，不依赖通用校验库。
// 注册时拒绝 Kernel 无法执行的校验构造。外部 JSON Schema 如需使用，必须先转换为该子集。
import { KernelError } from './error.js';

const MAX_SCHEMA_DEPTH = 8;
const SCHEMA_KEYS = [
  'type', 'properties', 'required', 'description', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'enum', 'items', 'anyOf', 'additionalProperties',
];
const VALUE_TYPES = ['string', 'integer', 'number', 'boolean'];
const NUMBER_TYPES = ['integer', 'number'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaType(schema: Record<string, unknown>): string | undefined {
  return typeof schema.type === 'string' ? schema.type : undefined;
}

function jsonScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function validateSchemaNode(
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  violations: string[],
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    violations.push(`${path} exceeds maximum schema depth ${MAX_SCHEMA_DEPTH}`);
    return;
  }

  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.includes(key)) violations.push(`${path}.${key} is not supported (subset: ${SCHEMA_KEYS.join('/')})`);
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    violations.push(`${path}.description must be a string`);
  }

  const type = schemaType(schema);
  if (schema.type !== undefined && (type === undefined || ![...VALUE_TYPES, 'object', 'array'].includes(type))) {
    violations.push(`${path}.type "${String(schema.type)}" is not supported (subset: ${[...VALUE_TYPES, 'object', 'array'].join('/')})`);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.some((value) => !jsonScalar(value))) {
      violations.push(`${path}.enum must be a non-empty array of JSON scalar values`);
    } else if (type !== undefined && schema.enum.some((value) => !matchesType(type, value))) {
      violations.push(`${path}.enum values must match type ${type}`);
    }
  }

  for (const bound of ['minimum', 'maximum']) {
    if (schema[bound] === undefined) continue;
    if (typeof schema[bound] !== 'number' || !Number.isFinite(schema[bound])) {
      violations.push(`${path}.${bound} must be a finite number`);
    } else if (type === undefined || !NUMBER_TYPES.includes(type)) {
      violations.push(`${path}.${bound} needs type integer or number`);
    }
  }
  for (const bound of ['minLength', 'maxLength']) {
    if (schema[bound] === undefined) continue;
    if (!Number.isSafeInteger(schema[bound]) || (schema[bound] as number) < 0) {
      violations.push(`${path}.${bound} must be a non-negative safe integer`);
    } else if (type !== 'string') {
      violations.push(`${path}.${bound} needs type string`);
    }
  }
  if (typeof schema.minLength === 'number' && typeof schema.maxLength === 'number'
    && Number.isSafeInteger(schema.minLength) && Number.isSafeInteger(schema.maxLength)
    && schema.minLength > schema.maxLength) {
    violations.push(`${path} has minLength above maxLength`);
  }
  for (const bound of ['minItems', 'maxItems']) {
    if (schema[bound] === undefined) continue;
    if (!Number.isSafeInteger(schema[bound]) || (schema[bound] as number) < 0) {
      violations.push(`${path}.${bound} must be a non-negative safe integer`);
    } else if (type !== 'array') violations.push(`${path}.${bound} needs type array`);
  }
  if (typeof schema.minItems === 'number' && typeof schema.maxItems === 'number' && schema.minItems > schema.maxItems) {
    violations.push(`${path} has minItems above maxItems`);
  }
  if (type !== undefined && NUMBER_TYPES.includes(type)
    && typeof schema.minimum === 'number' && typeof schema.maximum === 'number'
    && Number.isFinite(schema.minimum) && Number.isFinite(schema.maximum) && schema.minimum > schema.maximum) {
    violations.push(`${path} has minimum above maximum`);
  }

  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      violations.push(`${path}.anyOf must be a non-empty array of schemas`);
    } else {
      if (Object.keys(schema).some((key) => key !== 'anyOf' && key !== 'description' && !(key === 'type' && type === 'object'))) {
        violations.push(`${path}.anyOf cannot be combined with other validation keywords`);
      }
      schema.anyOf.forEach((branch, index) => {
        const branchPath = `${path}.anyOf[${index}]`;
        if (!isPlainObject(branch)) violations.push(`${branchPath} must be a schema object`);
        else validateSchemaNode(branch, branchPath, depth + 1, violations);
      });
    }
  }

  if (type === 'object') {
    const properties = schema.properties ?? {};
    if (!isPlainObject(properties)) {
      violations.push(`${path}.properties must be an object of schemas`);
    } else {
      for (const [name, child] of Object.entries(properties)) {
        const childPath = path === '' ? name : `${path}.${name}`;
        if (!isPlainObject(child)) violations.push(`${childPath} must be a schema object`);
        else validateSchemaNode(child, childPath, depth + 1, violations);
      }
    }
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) {
      violations.push(`${path === '' ? 'required' : `${path}.required`} must be an array of strings`);
    } else {
      for (const key of required) {
        if (!isPlainObject(properties) || !Object.hasOwn(properties, key)) {
          violations.push(`${path === '' ? '' : `${path}.`}required names "${key}" which is not in properties`);
        }
      }
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      violations.push(`${path === '' ? 'additionalProperties' : `${path}.additionalProperties`} must be false`);
    }
    return;
  }

  if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    const keyword = schema.properties !== undefined ? 'properties' : schema.required !== undefined ? 'required' : 'additionalProperties';
    violations.push(`${path}.${keyword} requires type object`);
  }

  if (type === 'array') {
    if (!isPlainObject(schema.items)) {
      violations.push(`${path}.items must be a schema object`);
    } else {
      validateSchemaNode(schema.items, `${path}.items`, depth + 1, violations);
    }
  } else if (schema.items !== undefined) {
    violations.push(`${path}.items requires type array`);
  }
}

function matchesType(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  return true;
}

// 注册时列出所有不支持构造及其路径，便于一次修正完整模式。
export function assertSupportedSchema(schema: Record<string, unknown>): void {
  const violations: string[] = [];
  validateSchemaNode(schema, '', 0, violations);
  if (violations.length > 0) {
    throw new KernelError('tool_parameters_unsupported_construct', { detail: violations.join('; ') });
  }
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string, violations: string[]): void {
  const type = schemaType(schema);
  if (type === 'string' && typeof value !== 'string') {
    violations.push(`"${path}" must be a string`);
    return;
  } else if (type === 'integer' && !Number.isInteger(value)) {
    violations.push(`"${path}" must be an integer`);
    return;
  } else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    violations.push(`"${path}" must be a number`);
    return;
  } else if (type === 'boolean' && typeof value !== 'boolean') {
    violations.push(`"${path}" must be a boolean`);
    return;
  } else if (type === 'object' && !isPlainObject(value)) {
    violations.push(`"${path}" must be an object`);
    return;
  } else if (type === 'array' && !Array.isArray(value)) {
    violations.push(`"${path}" must be an array`);
    return;
  }

  if (Array.isArray(schema.anyOf)) {
    const valid = schema.anyOf.some((branch) => {
      if (!isPlainObject(branch)) return false;
      const branchViolations: string[] = [];
      validateValue(branch, value, path, branchViolations);
      return branchViolations.length === 0;
    });
    if (!valid) violations.push(`"${path}" must match one of the allowed schemas`);
    return;
  }

  if (type === 'string' && typeof value === 'string') {
    const length = Array.from(value).length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      violations.push(`"${path}" must contain at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      violations.push(`"${path}" must contain at most ${schema.maxLength} characters`);
    }
  }

  if (schema.enum !== undefined && Array.isArray(schema.enum) && !schema.enum.some((option) => Object.is(option, value))) {
    violations.push(`"${path}" must be one of the allowed values`);
  }
  if (type !== undefined && NUMBER_TYPES.includes(type) && typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) violations.push(`"${path}" must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) violations.push(`"${path}" must be at most ${schema.maximum}`);
  }

  if (type === 'object' && isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && value[key] === undefined) {
        violations.push(`missing required property "${path === '' ? key : `${path}.${key}`}"`);
      }
    }
    for (const [key, childValue] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) violations.push(`"${childPath}" is not allowed`);
      } else if (isPlainObject(childSchema)) {
        validateValue(childSchema, childValue, childPath, violations);
      }
    }
  } else if (type === 'array' && Array.isArray(value) && isPlainObject(schema.items)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) violations.push(`"${path}" must contain at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      violations.push(`"${path}" must contain at most ${schema.maxItems} items`);
      return;
    }
    value.forEach((item, index) => validateValue(schema.items as Record<string, unknown>, item, `${path}[${index}]`, violations));
  }
}

// 调用时使用受控子集校验参数，返回所有违规项；空列表表示合法。
// 未声明字段按 JSON Schema 默认规则允许，除非对象显式关闭 additionalProperties。
export function validateArgs(schema: Record<string, unknown>, args: unknown): string[] {
  if (!isPlainObject(args)) return ['arguments must be an object'];
  const violations: string[] = [];
  validateValue(schema, args, '', violations);
  return violations;
}
