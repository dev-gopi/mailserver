export type SecurityListType = "allow_sender" | "block_sender" | "allow_domain" | "block_domain" | "block_extension";

export interface SecurityPolicyValues {
  spamTagScore: number;
  spamRejectScore: number;
  greylistScore: number;
}

export interface EffectiveRecipientPolicy extends SecurityPolicyValues {
  address: string;
}

export interface ScopedSecurityPolicyOverrides {
  spamTagScore: number | null;
  spamRejectScore: number | null;
  greylistScore: number | null;
}

export function resolveEffectiveSecurityPolicy(
  globalValues: SecurityPolicyValues,
  domainOverrides?: ScopedSecurityPolicyOverrides | null,
  mailboxOverrides?: ScopedSecurityPolicyOverrides | null
): SecurityPolicyValues {
  return validateSecurityPolicyValues({
    spamTagScore: mailboxOverrides?.spamTagScore ?? domainOverrides?.spamTagScore ?? globalValues.spamTagScore,
    spamRejectScore: mailboxOverrides?.spamRejectScore ?? domainOverrides?.spamRejectScore ?? globalValues.spamRejectScore,
    greylistScore: mailboxOverrides?.greylistScore ?? domainOverrides?.greylistScore ?? globalValues.greylistScore
  });
}

export interface SecurityListEntryInput {
  listType: SecurityListType;
  value: string;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicyValues = {
  spamTagScore: 6,
  spamRejectScore: 15,
  greylistScore: 4
};

export function validateSecurityPolicyValues(values: SecurityPolicyValues): SecurityPolicyValues {
  const { spamTagScore, spamRejectScore, greylistScore } = values;
  if (![spamTagScore, spamRejectScore, greylistScore].every(Number.isFinite)) {
    throw new Error("All policy thresholds must be finite numbers");
  }
  if (spamTagScore < 2 || spamTagScore > 20) {
    throw new Error("Spam tag threshold must be between 2 and 20");
  }
  if (spamRejectScore < 5 || spamRejectScore > 50 || spamRejectScore <= spamTagScore) {
    throw new Error("Spam reject threshold must be between 5 and 50 and greater than the tag threshold");
  }
  if (greylistScore < 1 || greylistScore > 10) {
    throw new Error("Greylist threshold must be between 1 and 10");
  }
  return {
    spamTagScore: roundScore(spamTagScore),
    spamRejectScore: roundScore(spamRejectScore),
    greylistScore: roundScore(greylistScore)
  };
}

export function resolveStrictestTagThreshold(
  globalValues: SecurityPolicyValues,
  recipients: string[],
  effectivePolicies: EffectiveRecipientPolicy[]
): number {
  const global = validateSecurityPolicyValues(globalValues);
  const normalized = new Set(recipients.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!normalized.size) return global.spamTagScore;
  const applicable = effectivePolicies
    .filter((entry) => normalized.has(entry.address.trim().toLowerCase()))
    .map((entry) => validateSecurityPolicyValues(entry).spamTagScore);
  // Each effective row has already resolved mailbox > domain > organization.
  // Return the strictest threshold among recipients in a multi-recipient mail.
  return applicable.length ? Math.min(...applicable) : global.spamTagScore;
}

export function normalizeSecurityListValue(input: SecurityListEntryInput): string {
  const value = input.value.trim().toLowerCase();
  if (!value || value.length > 254 || /[\r\n\0\s]/.test(value)) {
    throw new Error("List value must be a single non-empty value without whitespace or line breaks");
  }

  switch (input.listType) {
    case "allow_sender":
    case "block_sender": {
      const at = value.lastIndexOf("@");
      if (at <= 0 || at === value.length - 1 || !/^[^<>(),;:\[\]\s@]+$/.test(value.slice(0, at))) {
        throw new Error("Sender entries must be a complete email address");
      }
      const domain = value.slice(at + 1);
      validateDomain(domain);
      return value;
    }
    case "allow_domain":
    case "block_domain":
      validateDomain(value);
      return value;
    case "block_extension": {
      const extension = value.replace(/^\./, "");
      if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(extension)) {
        throw new Error("Attachment extension must be 1–16 letters, digits, underscores or hyphens");
      }
      return extension;
    }
    default:
      throw new Error("Unsupported security list type");
  }
}

function validateDomain(value: string): void {
  if (value.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)) {
    throw new Error("Domain entry must be a fully qualified DNS domain");
  }
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function uclQuote(value: string): string {
  return JSON.stringify(value);
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, ".0");
}

/**
 * Generate Rspamd's monitored settings map. Every accepted local recipient is
 * assigned one effective policy. For multi-recipient messages, Rspamd's rule
 * priority makes the strictest matching recipient policy win. This avoids a
 * less restrictive mailbox overriding a stricter policy for another recipient.
 */
export function renderRspamdSettingsMap(
  globalValues: SecurityPolicyValues,
  recipients: EffectiveRecipientPolicy[]
): string {
  const global = validateSecurityPolicyValues(globalValues);
  const grouped = new Map<string, { values: SecurityPolicyValues; addresses: string[] }>();

  for (const recipient of recipients) {
    const address = recipient.address.trim().toLowerCase();
    if (!address || !/^[^\s@]+@[^\s@]+$/.test(address)) continue;
    const values = validateSecurityPolicyValues(recipient);
    const key = `${values.spamTagScore}|${values.spamRejectScore}|${values.greylistScore}`;
    const group = grouped.get(key) ?? { values, addresses: [] };
    group.addresses.push(address);
    grouped.set(key, group);
  }

  // Rspamd evaluates higher-priority settings rules first and applies only the
  // first matching rule within this settings source. Assign unique priorities
  // after sorting from strictest to most permissive, so multi-recipient mail
  // always receives the strictest policy regardless of rule-name ordering.
  const orderedGroups = [...grouped.values()].sort((a, b) =>
    a.values.spamTagScore - b.values.spamTagScore ||
    a.values.spamRejectScore - b.values.spamRejectScore ||
    a.values.greylistScore - b.values.greylistScore
  );

  const lines: string[] = [
    "# Generated by MailCore. Do not edit manually; changes are overwritten.",
    "settings {",
    "  mailcore_global_default {",
    "    priority = 1;",
    '    rcpt = "/.*/";',
    "    apply {",
    "      actions {",
    `        \"add header\" = ${formatScore(global.spamTagScore)};`,
    `        reject = ${formatScore(global.spamRejectScore)};`,
    `        greylist = ${formatScore(global.greylistScore)};`,
    "      }",
    "    }",
    "  }",
    ""
  ];

  orderedGroups.forEach((group, index) => {
    lines.push(`  mailcore_recipient_policy_${index + 1} {`);
    lines.push(`    priority = ${orderedGroups.length + 1 - index};`);
    for (const address of [...new Set(group.addresses)].sort()) {
      lines.push(`    rcpt = ${uclQuote(address)};`);
    }
    lines.push("    apply {");
    lines.push("      actions {");
    lines.push(`        \"add header\" = ${formatScore(group.values.spamTagScore)};`);
    lines.push(`        reject = ${formatScore(group.values.spamRejectScore)};`);
    lines.push(`        greylist = ${formatScore(group.values.greylistScore)};`);
    lines.push("      }");
    lines.push("    }");
    lines.push("  }");
    lines.push("");
  });

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function renderRspamdListMaps(entries: Array<{ list_type: SecurityListType; value: string }>): Record<string, string> {
  const files: Record<string, string[]> = {
    "allow_senders.map": [],
    "block_senders.map": [],
    "allow_domains.map": [],
    "block_domains.map": [],
    "block_extensions.map": []
  };
  const target: Record<SecurityListType, keyof typeof files> = {
    allow_sender: "allow_senders.map",
    block_sender: "block_senders.map",
    allow_domain: "allow_domains.map",
    block_domain: "block_domains.map",
    block_extension: "block_extensions.map"
  };
  for (const entry of entries) {
    const file = target[entry.list_type];
    if (file && !files[file].includes(entry.value)) files[file].push(entry.value);
  }
  return Object.fromEntries(Object.entries(files).map(([filename, values]) => [
    filename,
    `# Generated by MailCore. Do not edit manually; changes are overwritten.\n${values.sort().join("\n")}${values.length ? "\n" : ""}`
  ]));
}
