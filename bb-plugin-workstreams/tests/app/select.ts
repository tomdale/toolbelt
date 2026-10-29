import { fireEvent, screen, within } from "@testing-library/react";

/**
 * Chooses `option` from a `SelectField` (BB's Radix select): opens it from
 * the keyboard and clicks the option in its portalled list.
 */
export function chooseOption(trigger: HTMLElement, option: string | RegExp) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  const listbox = screen.getByRole("listbox");
  fireEvent.click(within(listbox).getByRole("option", { name: option }));
}
