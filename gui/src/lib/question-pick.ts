// A click on a question's option (or its number), in the question card (QuestionCard.tsx).

/**
 * One question, nothing picked and nothing typed or attached: the option is the answer, sent at once. Otherwise picks
 * are made, shown and sent with Answer: a picked one is unpicked, and one question keeps a single pick. That holds
 * while one is picked after what was attached or typed is removed, so a click meant to unpick it doesn't send it.
 */
export function pickOption(label: string, o: { multi?: boolean; reviewing: boolean; picked: readonly string[] }): { send: string[] } | { picked: string[] } {
    if (!o.multi && !o.reviewing && !o.picked.length) return { send: [label] };
    if (o.picked.includes(label)) return { picked: o.picked.filter((x) => x !== label) };
    return { picked: o.multi ? [...o.picked, label] : [label] };
}
