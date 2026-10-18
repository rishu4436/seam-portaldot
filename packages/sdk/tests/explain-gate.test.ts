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
      { code: 'step_order', detail: 'step 1 is next in order' }, { code: 'weird_new', detail: 'x y' }] } as SubmitCheck);
    expect(t).toContain('Safe to submit');
    expect(t).toContain('Checks that passed:');
    expect(t).toContain('- this step is next in the approved order (step_order: step 1 is next in order)');
    expect(t).toContain('- weird_new: x y');
  });
  it('never describes a failed check as passed', () => {
    const t = explainSubmitCheck(blocked('abi_hash_mismatch', [{ code: 'abi_hash_mismatch', detail: 'bad' }, { code: 'step_order', detail: 'step 1' }]));
    expect(t.split('Checks that passed:')[1]).not.toContain('abi_hash_mismatch');
    expect(t).toContain('step_order');
  });
  it('is unchanged without passed', () => {
    expect(explainSubmitCheck({ ok: true, reasons: [] } as unknown as SubmitCheck)).toBe('Safe to submit: the approval, runtime and signed bytes all match what was approved.');
    expect(explainSubmitCheck(blocked('approval_expired'))).toBe('Not submitted:\n- raw gate message');
  });
  it('has fixed wording for every real submit-time pass code', () => {
    const codes = ['step_order', 'previous_steps_ok', 'approval_unused', 'approval_valid_time', 'approval_intact', 'approval_matches', 'runtime_unchanged', 'signed_bytes_match', 'signed_dry_run_ok'];
    const t = explainSubmitCheck({ ok: true, reasons: [], passed: codes.map((code) => ({ code, detail: `d-${code}` })) } as SubmitCheck);
    const lines = t.split('Checks that passed:\n')[1].split('\n');
    expect(lines).toHaveLength(codes.length);
    codes.forEach((c, i) => expect(lines[i]).toMatch(new RegExp(`^- .+ \\(${c}: d-${c}\\)$`)));
    expect(t).not.toContain('- step_order:');
  });
  it('shows policy rule codes verbatim if they ever appear in passed', () => {
    const t = explainSubmitCheck({ ok: true, reasons: [], passed: [{ code: 'abi_pinned', detail: '0xabc' }] } as SubmitCheck);
    expect(t).toContain('- abi_pinned: 0xabc');
  });
  it('drops duplicates and failed codes from passed', () => {
    const t = explainSubmitCheck(blocked('approval_intact', [{ code: 'approval_intact', detail: 'x' }, { code: 'step_order', detail: 'a' }, { code: 'step_order', detail: 'b' }]));
    expect(t.match(/step_order/g)).toHaveLength(1);
    expect(t.split('Checks that passed:')[1]).not.toContain('approval_intact');
  });
});

describe('explainSubmitCheck approval expiry wording', () => {
  const msg = (code: string, message: string): SubmitCheck => ({ ok: false, reasons: [{ code, message }] }) as SubmitCheck;
  it('shows the tampered-expiry sentence as the gate wrote it', () => {
    expect(explainSubmitCheck(msg('approval_tampered', "Blocked: the approval's expiry was changed after it was approved.")))
      .toBe("Not submitted:\n- Blocked: the approval's expiry was changed after it was approved.");
  });
  it('shows the no-valid-expiry sentence as the gate wrote it', () => {
    expect(explainSubmitCheck(msg('approval_expired', 'Blocked: this approval has no valid expiry time. Approve again.')))
      .toBe('Not submitted:\n- Blocked: this approval has no valid expiry time. Approve again.');
  });
});
