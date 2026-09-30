import type { LocaleTag } from "../locale";
import type { MessageKey } from "./en";
import { es } from "./es";
import { pt_BR } from "./pt-BR";
import { id } from "./id";
import { vi } from "./vi";
import { tr } from "./tr";
import { ru } from "./ru";
import { th } from "./th";
import { zh_CN } from "./zh-CN";
import { ja } from "./ja";
import { ko } from "./ko";

/**
 * Every locale's catalogue, keyed by the same tag the picker offers.
 *
 * ENGLISH IS ABSENT ON PURPOSE. `en.ts` is the SOURCE, not a translation of
 * anything, and `translate()` returns it directly rather than looking it up
 * here — so there is no arrangement of this table that can make English wrong.
 */
export const CATALOGUES: Partial<Record<LocaleTag, Partial<Record<MessageKey, string>>>> = {
  "es": es,
  "pt-BR": pt_BR,
  "id": id,
  "vi": vi,
  "tr": tr,
  "ru": ru,
  "th": th,
  "zh-CN": zh_CN,
  "ja": ja,
  "ko": ko,
};
