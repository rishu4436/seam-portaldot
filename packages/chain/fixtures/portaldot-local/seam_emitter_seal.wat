;; seam_emitter_seal: same as ../devnode/seam_emitter.wat but with the OLD pallet-contracts import names (seal_input,
;; seal_deposit_event) that the organizers' Portaldot dev node (spec 1002, metadata V13) accepts. The ink! 5 demo
;; contract uses seal0.input / seal2.set_storage and cannot run there. deploy(): nothing. call(): emits one event
;; with data "SEAM" ++ call input (up to 64 bytes). Built with wabt 1.0.36.
(module
  (import "seal0" "seal_deposit_event" (func $deposit_event (param i32 i32 i32 i32)))
  (import "seal0" "seal_input" (func $input (param i32 i32)))
  (import "env" "memory" (memory 1 1))
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
