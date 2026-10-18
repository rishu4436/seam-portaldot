import { describe, expect, it } from 'vitest';
import type { SubmitCheck } from '@seam/policy';
import { explainSubmitCheck } from '../src/index.js';

const blocked = (code: string, passed?: SubmitCheck['passed']): SubmitCheck =>
  ({ ok: false, reasons: [{ code, message: 'raw gate message' }], ...(passed ? { passed } : {}) }) as SubmitCheck;

describe('explainSubmitCheck gate codes', () => {
  it('uses fixed wording for the new block codes', () => {
    for (const c of ['message_not_allowed', 'abi_hash_missing', 'abi_hash_mismatch']) {
      const t = explainSubmitCheck(blocked(c));
      expect(t).toMatch(/^Not submitted:\n- Blocked: /);
      expect(t).not.toContain('raw gate message');
    }
  });
  it('lists passed checks in plain wording and keeps unknown codes verbatim', () => {
    const t = explainSubmitCheck({ ok: true, reasons: [], passed: [
      { code: 'message_allowed', detail: 'transfer' }, { code: 'abi_pinned', detail: '0xabc' },
      { code: 'selector_allowed', detail: '0x6c337222' }, { code: 'weird_new', detail: 'x y' }] } as SubmitCheck);
    expect(t).toContain('Safe to submit');
    expect(t).toContain('Checks that passed:');
    expect(t).toContain('- the contract message is on the policy allowed list (message_allowed: transfer)');
    expect(t).toContain('- weird_new: x y');
  });
  it('never describes a failed check as passed', () => {
    const t = explainSubmitCheck(blocked('abi_hash_mismatch', [{ code: 'abi_hash_mismatch', detail: 'bad' }, { code: 'message_allowed', detail: 'transfer' }]));
    expect(t.split('Checks that passed:')[1]).not.toContain('abi_hash_mismatch');
    expect(t).toContain('message_allowed');
  });
  it('is unchanged without passed', () => {
    expect(explainSubmitCheck({ ok: true, reasons: [] } as unknown as SubmitCheck)).toBe('Safe to submit: the approval, runtime and signed bytes all match what was approved.');
    expect(explainSubmitCheck(blocked('approval_expired'))).toBe('Not submitted:\n- raw gate message');
  });
});
