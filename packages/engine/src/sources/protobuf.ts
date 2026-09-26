import { AppError } from '../errors';
export type ProtoValue = number | Uint8Array;
export type ProtoFields = Map<number, ProtoValue[]>;

export function decodeFields(bytes: Uint8Array): ProtoFields {
  let offset = 0,
    fields = 0;
  const out: ProtoFields = new Map();
  const invalid = () => new AppError('INVALID_PROTOBUF', '来源返回了损坏的剧集数据');
  function varint(): number {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw invalid();
      const byte = bytes[offset++];
      result |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) {
        if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
        return Number(result);
      }
    }
    throw invalid();
  }
  while (offset < bytes.length) {
    if (++fields > 100000) throw invalid();
    const tag = varint(),
      field = Math.floor(tag / 8),
      wire = tag & 7;
    if (!field) throw invalid();
    let value: ProtoValue;
    if (wire === 0) value = varint();
    else if ([1, 2, 5].includes(wire)) {
      const size = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (offset + size > bytes.length) throw invalid();
      value = bytes.subarray(offset, offset + size);
      offset += size;
    } else throw invalid();
    const values = out.get(field);
    if (values) values.push(value);
    else out.set(field, [value]);
  }
  return out;
}
export const protoText = (f: ProtoFields, n: number) => {
  const v = f.get(n)?.[0];
  return v instanceof Uint8Array ? new TextDecoder().decode(v) : '';
};
export const protoInt = (f: ProtoFields, n: number) => {
  const v = f.get(n)?.[0];
  return typeof v === 'number' ? v : 0;
};
export const protoItems = (bytes: Uint8Array): ProtoFields[] =>
  (decodeFields(bytes).get(1) ?? [])
    .filter((v): v is Uint8Array => v instanceof Uint8Array)
    .map(decodeFields);
