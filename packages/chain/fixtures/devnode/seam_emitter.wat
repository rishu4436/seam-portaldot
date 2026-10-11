;; seam_emitter: smallest pallet-contracts (ink!-ABI-compatible) Wasm contract that emits an event.
;; deploy(): does nothing. call(): deposits one event with no topics and data "SEAM" ++ call input
;; (up to 64 bytes), so Contracts.ContractEmitted shows what was called. Built with wat2wasm (wabt 1.0.36).
(module
  (import "seal0" "deposit_event" (func $deposit_event (param i32 i32 i32 i32)))
  (import "seal0" "input" (func $input (param i32 i32)))
  (import "env" "memory" (memory 1 1))
  ;; [0]   topics: SCALE Vec<H256> with zero entries = 0x00
  ;; [16]  "SEAM" then the call input
  ;; [128] u32 length slot for seal0.input (capacity 64)
  (data (i32.const 16) "SEAM")
  (func (export "deploy"))
  (func (export "call")
    (i32.store (i32.const 128) (i32.const 64))
    (call $input (i32.const 20) (i32.const 128))
    (call $deposit_event
      (i32.const 0) (i32.const 1)
      (i32.const 16) (i32.add (i32.const 4) (i32.load (i32.const 128))))
  )
)
