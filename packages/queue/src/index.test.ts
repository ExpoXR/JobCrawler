import { describe, expect, test } from 'vitest';

import { normalizeJobId } from './index';

describe('normalizeJobId', () => {
  test('escapes BullMQ-reserved separators without changing UUIDs', () => {
    expect(normalizeJobId('discovery:4e9d4d8e-7db5-4d98-941e-f50265661142')).toBe(
      'discovery%3A4e9d4d8e-7db5-4d98-941e-f50265661142',
    );
  });
});
