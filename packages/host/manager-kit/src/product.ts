/**
 * Names the operator sees. Host and every manager read them from the kit;
 * `scripts/check-name.mjs` refuses the product word in any other source file.
 *
 * PRODUCT is still the name in messages, labels, and the manager keyword.
 * The binary, the config file, and the home directory each have their own
 * constant, so one can change without the others.
 */
export const PRODUCT = "mason";

/** The binary. The runtime package's `bin` must match. */
export const CLI_NAME = "mason";

/** The config file init writes, and the one looked up, when --config is absent. */
export const DEFAULT_CONFIG_FILENAME = "mason.config.yaml";

/** The directory Host owns when the config names none. */
export const HOME_DIR = ".mason";
