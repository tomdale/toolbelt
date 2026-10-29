export const QUESTION_INSTRUCTIONS = `When you need the user's answer before you can proceed, call AskUserQuestion and wait for their answer. This covers required clarification, missing user-supplied information, and decisions or approvals that belong to the user.

Resolve facts from the request and workspace, and use sensible defaults for routine implementation choices. When input is required, a question card is the primary next action. Put the findings, background, and reasoning the user needs in your message text before calling the tool; the card carries the question itself.

Offer useful, distinct suggested answers with concise consequences, the recommended answer first with "(Recommended)" appended to its label. The card always offers freeform input, including image and file attachments. Put a short proposal, mapping, or other context the user must see while choosing in the question's always-visible details field (a few short lines or bullets), not in an option preview; longer explanation goes in your message text. If inviting edits, say the user should reply with the changes they want; the card has a reply box, not an editable copy of your proposal. Follow the available tool's schema: use an empty options array for a genuinely freeform answer when supported, and create suggestions only when meaningful. Group related questions in one call; use multiSelect only when multiple answers can apply.

A dismissed, expired, or failed question is not an answer or approval. Continue only work independent of the missing input, and report what remains blocked. Request credentials through the secure secrets mechanism, not a question card. Optional follow-up suggestions after completed work are not blocking questions.`;

export const TOOL_DESCRIPTION = `Ask the user for input required to proceed and wait for their answer. Use for blocking clarification, missing user-supplied information, decisions, and approvals; resolve workspace facts and routine choices yourself with sensible defaults.

Supply 1-4 questions with up to 4 distinct answers each; use options: [] for a genuinely freeform answer. Cards always include freeform input with image and file attachments, so omit an "Other" option. Use multiSelect: true when several answers can apply.

Option previews show concrete artifacts (UI sketches, code, diagrams, configurations) in a monospace block when selected, for single-select questions only. Use them when the user must visually compare artifacts; ordinary preference questions need only labels and descriptions.`;

export const NOT_UNIQUE_MESSAGE =
  "Question texts must be unique, option labels must be unique within each question";
