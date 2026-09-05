import { redactSensitiveText } from './evidence.js';

/** Walk values before serialization: text regexes must never rewrite JSON syntax. */
export function redactValue<T>(value:T):T {
  if(typeof value==='string')return redactSensitiveText(value) as T;
  if(Array.isArray(value))return value.map(redactValue) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[
    key,/^(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret)$/i.test(key)?'[REDACTED]':redactValue(entry),
  ])) as T;
  return value;
}
