export const QUESTION_INSTRUCTIONS = `When you need the user's answer before you can proceed, call AskUserQuestion and wait for the answer. This applies to required clarification, missing user-supplied information, and decisions or approvals that belong to the user.

Resolve facts from the request and workspace, and use sensible defaults for routine implementation choices. When input is required, a question card is the primary next action. You may give a brief progress summary before calling the tool.

Offer useful, distinct suggested answers with concise consequences. Put your recommended answer first and append "(Recommended)" to its label. The card always offers freeform input. Follow the available tool's schema: use an empty options array for a genuinely freeform answer when supported, and create suggestions only when they are meaningful. Group related questions in one call and use multiSelect only when multiple answers can apply.

A dismissed, expired, or failed question is not an answer or approval. Continue only work independent of the missing input, and clearly report what remains blocked. Request credentials through the secure secrets mechanism rather than a question card. Optional follow-up suggestions after completed work are not blocking questions.`;

export const TOOL_DESCRIPTION = `Ask the user for input required to proceed and wait for their answer. Use this tool for blocking clarification, missing user-supplied information, decisions, and approvals. Resolve workspace facts and routine choices with sensible defaults yourself.

Supply 1-4 questions. Offer up to 4 distinct suggested answers with concise descriptions; use options: [] for a genuinely freeform answer. Every card includes freeform input automatically, so omit an "Other" option. Put a recommendation first and append "(Recommended)" to its label. Use multiSelect: true when multiple answers can apply.

Optional option previews show concrete artifacts such as UI sketches, code, diagrams, or configurations in a monospace block when selected. Use previews when the user needs to visually compare concrete artifacts; ordinary preference questions need only labels and descriptions. Previews apply only to single-select questions. Request credentials through the secure secrets mechanism.`;

export const NOT_UNIQUE_MESSAGE =
  "Question texts must be unique, option labels must be unique within each question";
