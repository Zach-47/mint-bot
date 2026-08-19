import {
  CONTRACT,
  GAS_MINT,
  SLOT_MINT_ACTIVE,
  SLOT_VALUE_ACTIVE,
  type Config,
} from "./config.js";
import { fail, log, ok, warn } from "./log.js";
import { callSafe } from "./rpc.js";
import { mintCalldata } from "./presign.js";

// Measured live against this contract with the slot-7 override:
// mint(1) = 107,430   mint(2) = 133,028
const EXPECTED_GAS = 133_028n;

/**
 * Proves the mint would succeed right now, while mintActive is still false,
 * by overriding storage slot 7 - packed [metadataFrozen:1][mintActive:1][owner:20]
 * from the high end - so mintActive = true while the owner is preserved.
 *
 * The only thing this fakes is the flag we are waiting on. Everything else is
 * the real contract, the real wallet, the real balance and the real calldata.
 */
export async function simulate(cfg: Config): Promise<number> {
  const data = mintCalldata(cfg.quantity);
  const valueHex = "0x" + cfg.mintValue.toString(16);
  const stateOverride = {
    [CONTRACT]: { stateDiff: { [SLOT_MINT_ACTIVE]: SLOT_VALUE_ACTIVE } },
  };

  log(`simulating mint(${cfg.quantity}) value=${valueHex} with mintActive overridden true`);
  log(`slot  ${SLOT_MINT_ACTIVE}`);
  log(`value ${SLOT_VALUE_ACTIVE}`);

  let failures = 0;
  for (const w of cfg.wallets) {
    const r = await callSafe(cfg.rpcUrl, "eth_estimateGas", [
      { from: w.address, to: CONTRACT, data, value: valueHex },
      "latest",
      stateOverride,
    ]);
    if (r.error) {
      failures++;
      const m = r.error.message.toLowerCase();
      const why = m.includes("insufficient funds")
        ? " -- wallet is under-funded, this is a balance problem not a contract problem"
        : m.includes("execution reverted")
          ? " -- contract rejected the call (check quantity, value and wallet limit)"
          : "";
      fail(`wallet[${w.index}] ${w.address} FAILED: ${r.error.message}${why}`);
      continue;
    }
    const gas = BigInt(r.result as string);
    const delta = gas > EXPECTED_GAS ? gas - EXPECTED_GAS : EXPECTED_GAS - gas;
    if (gas > GAS_MINT) {
      failures++;
      fail(`wallet[${w.index}] gas ${gas} EXCEEDS gasLimit ${GAS_MINT}`);
    } else if (delta > 5_000n) {
      warn(`wallet[${w.index}] gas ${gas} (expected ~${EXPECTED_GAS}, delta ${delta}) - within limit but unexpected`);
    } else {
      ok(`wallet[${w.index}] ${w.address} gas=${gas} (limit ${GAS_MINT}, headroom ${GAS_MINT - gas})`);
    }
  }

  log(`simulate: ${cfg.wallets.length - failures}/${cfg.wallets.length} wallets would mint successfully`);
  return failures;
}
