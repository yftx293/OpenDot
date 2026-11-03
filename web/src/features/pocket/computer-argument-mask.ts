const SECRET_FIELD =
  /password|passwd|passcode|secret|secure|credential|pin\b|密码|口令|axsecuretextfield/i;

export function maskSensitiveComputerArguments<T>(args: T): T {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  if (record.action !== 'set_value' && record.action !== 'type_text')
    return args;
  const haystack = [record.element, record.label, record.name, record.role]
    .filter((value) => typeof value === 'string')
    .join('\n');
  if (!SECRET_FIELD.test(haystack)) return args;
  const masked = { ...record };
  if (typeof masked.value === 'string') masked.value = '••••••';
  if (typeof masked.text === 'string') masked.text = '••••••';
  return masked as T;
}
