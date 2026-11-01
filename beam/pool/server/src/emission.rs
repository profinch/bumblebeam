//! Beam's miner reward by height (core `Rules::get_Emission`, mainnet): 100 BEAM a block in year
//! one with 20 to the treasury, halving every four years, the treasury took 10 of 50 in years two
//! to five and nothing since. Miners get 80, 40, 25, 12.5, ... Confirmed against coinbase outputs.

pub const GROTH: u64 = 100_000_000;
const DROP0: u64 = 525_600;
const DROP1: u64 = 2_102_400;

pub fn miner_reward_groth(height: u64) -> u64 {
    if height < DROP0 {
        return 80 * GROTH;
    }
    let n = 1 + (height - DROP0) / DROP1;
    if n >= 60 {
        return 0;
    }
    let full = (100 * GROTH) >> n;
    let treasury = if n == 1 { 10 * GROTH } else { 0 };
    full - treasury
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schedule() {
        assert_eq!(miner_reward_groth(1), 80 * GROTH);
        assert_eq!(miner_reward_groth(600_000), 40 * GROTH);
        assert_eq!(miner_reward_groth(4_068_800), 25 * GROTH);
        assert_eq!(miner_reward_groth(4_730_400), 125 * GROTH / 10);
    }
}
