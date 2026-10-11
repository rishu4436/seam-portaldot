//! SEAM demo contract (ink! 5).
//!
//! `settle(order_id, amount)` records the caller's settlement and emits `Settled` on **every** call, so a
//! SEAM receipt can mark the `contracts.call` step `verified` (it sees `Contracts.ContractEmitted` from this
//! contract) instead of `unknown`.
//!
//! Selectors are ink!'s defaults: the first 4 bytes of blake2b-256 of the message label.
//! They don't depend on the ink! version, so an ink! 3 build for Portaldot mainnet would keep them (see README).
#![cfg_attr(not(feature = "std"), no_std, no_main)]

#[ink::contract]
mod seam_demo {
    /// Emitted on every successful `settle`.
    #[ink(event)]
    pub struct Settled {
        #[ink(topic)]
        caller: AccountId,
        #[ink(topic)]
        order_id: u64,
        amount: Balance,
    }

    /// The most recent settlement.
    #[derive(Debug, Clone, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    #[cfg_attr(feature = "std", derive(ink::storage::traits::StorageLayout))]
    pub struct Settlement {
        pub caller: AccountId,
        pub order_id: u64,
        pub amount: Balance,
        pub block: BlockNumber,
    }

    #[ink(storage)]
    #[derive(Default)]
    pub struct SeamDemo {
        last: Option<Settlement>,
        count: u64,
    }

    impl SeamDemo {
        #[ink(constructor)]
        pub fn new() -> Self {
            Self::default()
        }

        /// Records a settlement and emits `Settled { caller, order_id, amount }`.
        /// Not payable: SEAM's compiler rejects a non-zero `value` for it.
        #[ink(message)]
        pub fn settle(&mut self, order_id: u64, amount: Balance) {
            let caller = self.env().caller();
            self.last = Some(Settlement { caller, order_id, amount, block: self.env().block_number() });
            self.count = self.count.saturating_add(1);
            self.env().emit_event(Settled { caller, order_id, amount });
        }

        /// The last settlement, if any.
        #[ink(message)]
        pub fn last_settlement(&self) -> Option<Settlement> {
            self.last.clone()
        }

        /// How many times `settle` has been called.
        #[ink(message)]
        pub fn settlement_count(&self) -> u64 {
            self.count
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[ink::test]
        fn settle_stores_and_emits() {
            let accounts = ink::env::test::default_accounts::<ink::env::DefaultEnvironment>();
            ink::env::test::set_caller::<ink::env::DefaultEnvironment>(accounts.alice);
            let mut c = SeamDemo::new();
            assert_eq!(c.last_settlement(), None);
            c.settle(7, 2_500_000_000_000_000);
            c.settle(8, 1);
            let last = c.last_settlement().expect("stored");
            assert_eq!((last.caller, last.order_id, last.amount), (accounts.alice, 8, 1));
            assert_eq!(c.settlement_count(), 2);
            assert_eq!(ink::env::test::recorded_events().count(), 2);
        }
    }
}
