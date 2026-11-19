import arrowRight from "./assets/icons/arrow-right.svg?raw";
import check from "./assets/icons/check.svg?raw";
import download from "./assets/icons/download.svg?raw";
import fileText from "./assets/icons/file-text.svg?raw";
import folder from "./assets/icons/folder.svg?raw";
import loaderCircle from "./assets/icons/loader-circle.svg?raw";
import refreshCw from "./assets/icons/refresh-cw.svg?raw";
import shieldCheck from "./assets/icons/shield-check.svg?raw";
import trash from "./assets/icons/trash.svg?raw";
import triangleAlert from "./assets/icons/triangle-alert.svg?raw";

// Иконки из набора брендбука LidFly (Figma → 01 · Токены и компоненты → Icon/*).
// Заливка — currentColor, цвет задаётся в styles.css.
const icons = {
  "arrow-right": arrowRight,
  check,
  download,
  "file-text": fileText,
  folder,
  "loader-circle": loaderCircle,
  "refresh-cw": refreshCw,
  "shield-check": shieldCheck,
  trash,
  "triangle-alert": triangleAlert,
} as const;

export type IconName = keyof typeof icons;

export function iconSvg(name: IconName): string {
  return icons[name];
}

export function icon(name: IconName, className = ""): string {
  return `<span class="icon ${className}" aria-hidden="true">${icons[name]}</span>`;
}
