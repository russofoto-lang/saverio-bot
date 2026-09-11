export type LearningRuleScope = "calendar_classification" | "meaning" | "behavior";

export type LearningRuleDraft = {
  scope: LearningRuleScope;
  trigger: string;
  instruction: string;
  effect?: "work" | "personal";
  replacement?: string;
};

export type LearningCommand =
  | { kind: "list" }
  | { kind: "delete"; index: number }
  | { kind: "propose"; draft: LearningRuleDraft }
  | { kind: "none" };

export type LearnedRule = LearningRuleDraft & {
  id: string;
  createdAt: string;
};

export function normalizeLearningText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanFragment(value: string): string {
  return value.trim().replace(/^[,:;\-\s]+|[.!?\s]+$/g, "").trim();
}

export function parseLearningCommand(text: string): LearningCommand {
  const original = text.trim();
  const value = normalizeLearningText(original);

  if (/^(?:\/imparato|cosa hai imparato|mostra(?:mi)? (?:le )?regole|quali regole (?:hai|ricordi)|regole imparate)[?!.]*$/.test(value)) {
    return { kind: "list" };
  }

  const deletion = value.match(/^(?:dimentica|cancella|elimina|rimuovi) (?:la )?regola (\d+)[?!.]*$/);
  if (deletion) return { kind: "delete", index: Number(deletion[1]) };

  const meaning = original.match(/^(?:no[,;:]?\s*)?(?:ricorda(?:ti)?(?:\s+che)?\s+)?quando dico\s+[“"']?(.+?)[”"']?\s+intendo\s+[“"']?(.+?)[”"']?[.!?]*$/i);
  if (meaning) {
    const trigger = cleanFragment(meaning[1]);
    const replacement = cleanFragment(meaning[2]);
    if (trigger && replacement) {
      return {
        kind: "propose",
        draft: {
          scope: "meaning",
          trigger,
          replacement,
          instruction: `Quando Mariano dice "${trigger}", interpretalo come "${replacement}".`,
        },
      };
    }
  }

  const explicitCorrection = /^(?:no[,;:]?|hai sbagliato[,;:]?|correzione\s*:|impara\s*:|impara che\b|ricorda come regola(?: che)?\b|da ora in poi\b)/.test(value);
  if (!explicitCorrection) return { kind: "none" };

  const withoutPrefix = original
    .replace(/^(?:no[,;:]?\s*|hai sbagliato[,;:]?\s*|correzione\s*:\s*|impara\s*:\s*|impara che\s+|ricorda come regola(?: che)?\s+|da ora in poi\s+)/i, "")
    .trim();
  const classification = withoutPrefix.match(/^(.+?)\s+(?:e|è)\s+(?:(?:un|una)\s+)?(?:(?:impegno|evento)\s+)?(personale|privato|privata|lavorativo|lavorativa|di lavoro)[.!?]*$/i);
  if (classification) {
    const trigger = cleanFragment(classification[1]);
    const label = normalizeLearningText(classification[2]);
    const effect = label === "personale" || label === "privato" || label === "privata" ? "personal" : "work";
    return {
      kind: "propose",
      draft: {
        scope: "calendar_classification",
        trigger,
        effect,
        instruction: `Negli eventi Calendar, considera "${trigger}" come ${effect === "work" ? "lavorativo" : "personale"}.`,
      },
    };
  }

  const instruction = cleanFragment(withoutPrefix);
  if (!instruction) return { kind: "none" };
  return {
    kind: "propose",
    draft: {
      scope: "behavior",
      trigger: instruction.slice(0, 120),
      instruction: instruction.charAt(0).toUpperCase() + instruction.slice(1),
    },
  };
}

export function applyMeaningRules(text: string, rules: LearnedRule[]): string {
  let result = text;
  for (const rule of rules) {
    if (rule.scope !== "meaning" || !rule.trigger || !rule.replacement) continue;
    const escaped = rule.trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "giu"), (matched) => `${matched} (${rule.replacement})`);
  }
  return result;
}

export function classifyWithLearnedRules(title: string, rules: LearnedRule[]): "work" | "personal" | null {
  const normalizedTitle = normalizeLearningText(title);
  const matches = rules.filter((rule) => rule.scope === "calendar_classification"
    && Boolean(rule.effect)
    && normalizedTitle.includes(normalizeLearningText(rule.trigger)));
  return matches.length ? matches[matches.length - 1].effect ?? null : null;
}
