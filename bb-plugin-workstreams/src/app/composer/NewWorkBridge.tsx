/**
 * Connects New work to the composer it embeds. `useComposer()` names the
 * dialog's composer only from inside one of that composer's slots, so this
 * mounts as a composer action, which renders no box when empty. It renders
 * nothing, and only inside New work: every other new-thread composer has no
 * `NewWorkContext`.
 */
import { useContext, useEffect } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { NewWorkContext, type NewWork } from "./new-work.ts";

export function NewWorkBridge() {
  const newWork = useContext(NewWorkContext);
  return newWork ? <Bridge newWork={newWork} /> : null;
}

function Bridge({ newWork }: { newWork: NewWork }) {
  const composer = useComposer();
  const { text, selection } = composer;
  useEffect(() => newWork.attach(composer), [newWork, composer]);
  useEffect(() => newWork.observe(text), [newWork, text]);
  useEffect(() => newWork.observeSelection(selection), [newWork, selection]);
  return null;
}
