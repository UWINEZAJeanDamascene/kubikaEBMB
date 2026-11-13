# Shared POS flow and configurable till types

Retail remains the reference checkout. Every register uses the same POS session, shift, cart, sale, payment, receipt, cash movement, and reporting services. A till type is a company-configured profile key used to select settings; adding a key does not introduce new checkout rules or imply a specialized domain workflow.

## Add another till profile

1. Open POS Back Office and go to **Discount settings**.
2. Add the lowercase profile name (for example `supermarket` or `wholesale`) under **System till types**. Keep `retail` in the list.
3. Configure its feature switches and any payment, discount, offline, accounting, or approval overrides that the company needs.
4. Assign the profile to the register and save.

Register assignments are checked against the company's configured type list. The shared till flow handles the register without a domain-specific controller. Unsupported offline operations remain blocked by the existing offline action policy. A future domain-specific feature must be added as an explicit extension to the shared interfaces rather than a fork of checkout behavior.

Payment-method and write-off-threshold overrides accept validated profile keys instead of a code-level allowlist. Payment accounting readiness is checked for built-in types, configured payment override types, and active register types.

Adding a profile does not migrate historical registers or change their type. Changes are company-scoped and audit logged through POS discount settings and register assignment endpoints.
