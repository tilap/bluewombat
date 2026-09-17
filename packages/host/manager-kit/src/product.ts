/**
 * The name the product goes by — the binary, the config file, the home
 * directory, the labels a manager writes, the words in a message. It is
 * written here once. Host and every manager read it from the kit; the only
 * other file that spells it is `isolation-git`'s branch prefix, which has no
 * kit to import. `scripts/check-name.mjs` refuses it anywhere else in source.
 */
export const PRODUCT = "mason";
