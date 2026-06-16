use pinocchio::pubkey::Pubkey;

use super::order::{OrderType, Side};

pub const MAX_COMMITMENTS: usize = 500;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchStatus {
    Committing = 0,
    Revealing = 1,
    Clearing = 2,
    Settled = 3,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Batch {
    pub batch_id: u64,
    pub status: BatchStatus,
    pub _pad_status: [u8; 7],
    pub commit_deadline_slot: u64,
    pub reveal_deadline_slot: u64,
    pub close_slot: u64,
    pub shuffle_seed: u64,
    pub clearing_price: i64,
    pub total_commitments: u32,
    pub total_revealed: u32,
    pub total_settled: u32,
    pub total_volume: u64,
    pub total_notional: u128,
    pub slashed_deposits: u128,
    pub bump: u8,
    pub _padding: [u8; 7],
}

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitmentStatus {
    Pending = 0,
    Revealed = 1,
    Slashed = 2,
    Settled = 3,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Commitment {
    pub batch_id: u64,
    pub user: Pubkey,
    pub order_hash: [u8; 32],
    pub deposit_lamports: u64,
    pub status: CommitmentStatus,
    pub _pad_status: [u8; 7],
    pub nonce: u64,
    pub revealed: RevealedOrder,
}

/// Revealed order stored on the commitment after RevealOrder succeeds.
/// Populated from the user's reveal input; consumed by ClearBatch and
/// SettleBatch. Layout follows design L307-317; salt kept as u64 to match
/// `Commitment.nonce` and the 8-byte hash input defined in 6g.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct RevealedOrder {
    pub user: Pubkey,
    pub price: i64,
    pub qty: u64,
    pub salt: u64,
    pub instrument_id: u16,
    pub commitment_idx: u32,
    pub order_type: OrderType,
    pub side: Side,
    pub reduce_only: bool,
    pub _padding: [u8; 3],
}

impl Default for RevealedOrder {
    fn default() -> Self {
        Self {
            user: Pubkey::default(),
            price: 0,
            qty: 0,
            salt: 0,
            instrument_id: 0,
            commitment_idx: 0,
            order_type: OrderType::LimitGTC,
            side: Side::Buy,
            reduce_only: false,
            _padding: [0; 3],
        }
    }
}

impl Batch {
    pub fn initialize_in_place(&mut self, batch_id: u64, commit_deadline_slot: u64, reveal_deadline_slot: u64, bump: u8) {
        self.batch_id = batch_id;
        self.status = BatchStatus::Committing;
        self._pad_status = [0; 7];
        self.commit_deadline_slot = commit_deadline_slot;
        self.reveal_deadline_slot = reveal_deadline_slot;
        self.close_slot = 0;
        self.shuffle_seed = 0;
        self.clearing_price = 0;
        self.total_commitments = 0;
        self.total_revealed = 0;
        self.total_settled = 0;
        self.total_volume = 0;
        self.total_notional = 0;
        self.slashed_deposits = 0;
        self.bump = bump;
        self._padding = [0; 7];
    }

    #[cfg(test)]
    pub fn new(batch_id: u64) -> Self {
        let mut b = Self {
            batch_id,
            status: BatchStatus::Committing,
            _pad_status: [0; 7],
            commit_deadline_slot: 0,
            reveal_deadline_slot: 0,
            close_slot: 0,
            shuffle_seed: 0,
            clearing_price: 0,
            total_commitments: 0,
            total_revealed: 0,
            total_settled: 0,
            total_volume: 0,
            total_notional: 0,
            slashed_deposits: 0,
            bump: 0,
            _padding: [0; 7],
        };
        b.initialize_in_place(batch_id, 0, 0, 0);
        b
    }
}

impl Commitment {
    pub fn initialize_in_place(&mut self, batch_id: u64, user: Pubkey, order_hash: [u8; 32], deposit_lamports: u64, nonce: u64) {
        self.batch_id = batch_id;
        self.user = user;
        self.order_hash = order_hash;
        self.deposit_lamports = deposit_lamports;
        self.status = CommitmentStatus::Pending;
        self._pad_status = [0; 7];
        self.nonce = nonce;
        self.revealed = RevealedOrder::default();
    }

    #[cfg(test)]
    pub fn new(batch_id: u64, user: Pubkey) -> Self {
        let mut c = Self {
            batch_id,
            user,
            order_hash: [0; 32],
            deposit_lamports: 0,
            status: CommitmentStatus::Pending,
            _pad_status: [0; 7],
            nonce: 0,
            revealed: RevealedOrder::default(),
        };
        c.initialize_in_place(batch_id, user, [0; 32], 0, 0);
        c
    }
}

impl RevealedOrder {
    /// Pack the revealed order fields into a 32-byte buffer.
    /// Layout (little-endian): user(32) | price(8) | qty(8) | salt(8) | instrument_id(2) | order_type(1) | side(1) | reduce_only(1) | pad(3)
    /// Wait — that's 64 bytes; we only have 32. Use a compact layout:
    ///   [0..8]   price
    ///   [8..16]  qty
    ///   [16]     side
    ///   [17]     order_type
    ///   [18]     reduce_only
    ///   [19..21] instrument_id
    ///   [21..29] salt
    ///   [29..32] unused
    /// Kept for backwards-compat decode in test paths; canonical storage is
    /// the typed `Commitment.revealed` field.
    #[cfg(test)]
    pub fn pack(&self) -> [u8; 32] {
        let mut buf = [0u8; 32];
        buf[0..8].copy_from_slice(&self.price.to_le_bytes());
        buf[8..16].copy_from_slice(&self.qty.to_le_bytes());
        buf[16] = self.side as u8;
        buf[17] = self.order_type as u8;
        buf[18] = self.reduce_only as u8;
        buf[19..21].copy_from_slice(&self.instrument_id.to_le_bytes());
        buf[21..29].copy_from_slice(&self.salt.to_le_bytes());
        buf
    }

    #[cfg(test)]
    pub fn unpack(buf: &[u8; 32], user: Pubkey, commitment_idx: u32) -> Self {
        let price = i64::from_le_bytes(buf[0..8].try_into().unwrap());
        let qty = u64::from_le_bytes(buf[8..16].try_into().unwrap());
        let side = Side::from_u8(buf[16]).unwrap_or(Side::Buy);
        let order_type = OrderType::from_u8(buf[17]).unwrap_or(OrderType::LimitGTC);
        let reduce_only = buf[18] != 0;
        let instrument_id = u16::from_le_bytes(buf[19..21].try_into().unwrap());
        let salt = u64::from_le_bytes(buf[21..29].try_into().unwrap());
        Self {
            user,
            price,
            qty,
            salt,
            instrument_id,
            commitment_idx,
            order_type,
            side,
            reduce_only,
            _padding: [0; 3],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pinocchio::pubkey::Pubkey;

    #[test]
    fn test_batch_new() {
        let b = Batch::new(1);
        assert_eq!(b.batch_id, 1);
        assert_eq!(b.status, BatchStatus::Committing);
        assert_eq!(b.total_commitments, 0);
        assert_eq!(b.close_slot, 0);
        assert_eq!(b.shuffle_seed, 0);
    }

    #[test]
    fn test_commitment_new() {
        let user = Pubkey::from([1u8; 32]);
        let c = Commitment::new(1, user);
        assert_eq!(c.batch_id, 1);
        assert_eq!(c.user, user);
        assert_eq!(c.status, CommitmentStatus::Pending);
        assert_eq!(c.revealed.user, Pubkey::default());
    }

    #[test]
    fn test_revealed_order_pack_unpack_roundtrip() {
        let user = Pubkey::from([7u8; 32]);
        let ro = RevealedOrder {
            user,
            price: 100_500_000,
            qty: 42,
            salt: 0xDEADBEEFCAFEBABE,
            instrument_id: 3,
            commitment_idx: 17,
            order_type: OrderType::LimitGTC,
            side: Side::Sell,
            reduce_only: true,
            _padding: [0; 3],
        };
        let buf = ro.pack();
        let decoded = RevealedOrder::unpack(&buf, user, 17);
        assert_eq!(decoded.price, ro.price);
        assert_eq!(decoded.qty, ro.qty);
        assert_eq!(decoded.salt, ro.salt);
        assert_eq!(decoded.instrument_id, ro.instrument_id);
        assert_eq!(decoded.commitment_idx, 17);
        assert_eq!(decoded.order_type, ro.order_type);
        assert_eq!(decoded.side, ro.side);
        assert_eq!(decoded.reduce_only, ro.reduce_only);
    }
}
