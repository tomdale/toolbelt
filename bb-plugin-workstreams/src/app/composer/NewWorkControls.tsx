import { useContext } from "react";
import { IntakeContext } from "./intake.ts";
import { IntakeBanner } from "./IntakeBanner.tsx";

/** The host composer owns the draft; only New work supplies an intake context. */
export function NewWorkControls() {
  const intake = useContext(IntakeContext);
  return intake ? <IntakeBanner intake={intake} /> : null;
}
