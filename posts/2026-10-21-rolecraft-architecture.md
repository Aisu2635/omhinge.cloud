---
title: Designing RoleCraft, a browser-only AWS IAM policy builder
date: 2026-10-21
summary: Why I built a tool that turns plain sentences into least-privilege IAM roles, and how it works underneath: a static data pipeline over 456 AWS services, a pure TypeScript policy engine, five export formats and a CI that applies every export to an AWS emulator.
tags: [aws, iam, system-design, architecture, typescript]
cover: /assets/blog/rolecraft-architecture/cover.png
---

[RoleCraft](https://rolecraft.omhinge.cloud) is a tool I built for building AWS IAM roles and policies visually. You describe access in sentences ("can read files in `reports/` of `data-lake`"), and it produces the permission policy, the trust policy, and ready-to-run AWS CLI (bash and PowerShell), Terraform and CloudFormation. It runs entirely in the browser: no backend, no account, no AWS credentials. The code is open source on [GitHub](https://github.com/Aisu2635/RoleCraft).

This post covers why it exists and, mostly, how it's designed: the data pipeline, the core engine, the module system, the export layer, the APIs between them, and the CI that keeps the output honest.

![RoleCraft's architecture: everything runs in the browser, over static AWS data refreshed weekly.](/assets/blog/rolecraft-architecture/architecture.png)

## The problem

Writing IAM policies by hand is where least privilege usually dies. Not because people don't care, but because the correct version is fiddly, and the fiddly parts are exactly where it breaks:

| What goes wrong | Why it happens |
| --- | --- |
| `"Action": "*"` and `"Resource": "*"` everywhere | Scoping each action to the right ARN is tedious, so people stop |
| The S3 folder trap | `s3:ListBucket` needs the **bucket** ARN plus an `s3:prefix` condition; object actions need the **object** ARN. Mix them up and it silently doesn't work |
| Loose GitHub Actions trust | An OIDC trust policy without a `sub` condition lets *any* repository assume the role |
| Long-lived access keys | Creating a role with the right trust is harder than generating a key |
| "What does this policy actually allow?" | JSON doesn't explain itself |
| Format fragmentation | The same role is needed as JSON, CLI, Terraform or CloudFormation depending on the team |

I wanted something I'd actually use instead of hand-writing IAM JSON: fast, correct by default, and safe to paste into a terminal.

## Design goals

Those problems turned into a few hard constraints:

1. **Nothing the user types leaves the browser.** No backend, no database, no credentials. Account IDs and bucket names stay on the user's machine.
2. **Every AWS service, not a handful.** All 456 services in the AWS Service Reference can be added to a role.
3. **Correct by construction.** Every action is paired with a resource type it actually supports. `*` appears only when AWS requires it, and it gets flagged.
4. **One model, many outputs.** The policy, trust policy, CLI, Terraform and CloudFormation all come from the same source of truth, so they can't disagree.
5. **Fast enough to be a habit.** A correct "read one S3 folder" policy in under a minute from the landing page.

Constraint 1 shaped everything else: if there's no server, all the logic, all the data and all the validation have to live in the browser.

## High-level architecture

RoleCraft is a static single-page app on Cloudflare Pages, built with Vite, React 19 and TypeScript. It has three layers, plus the data it reads.

| Layer | What it does | Rule |
| --- | --- | --- |
| **UI** (React + Cloudscape) | Wizard, sentence and grid editors, service sidebar, output panel | Never builds JSON itself |
| **State** (Zustand) | Holds the `RoleModel`, derives output once per edit, syncs the share link | The model is the single source of truth |
| **Core** (pure TypeScript) | Catalog, engine, modules, trust, validation, lint, explainer, exporters | No React imports, never touches the DOM |
| **Static data** | `/data/index.json` + `/data/svc/<service>.json` | Generated at build time from AWS's published reference |

The split between UI and core is the most important decision in the project. The core is a set of pure functions: `RoleModel` in, documents and issues out. That makes it fully unit-testable, lets CI run the exact same code as the browser, and means a bug in a React component can never produce a wrong policy.

## The data pipeline

To pair every action with the right resource ARN, the app needs to know, for every service, every action, its access level, which resource types it supports and their ARN formats. AWS publishes exactly this as the **Service Authorization Reference**, as JSON.

The raw files are big, so a build-time script turns them into a slim shape:

```ts src/core/types.ts
interface SlimService {
  key: string;                 // "s3" (the IAM action prefix)
  name: string;                // "Amazon S3"
  category: Category;          // curated for the most-used services, "Other" otherwise
  actions: SlimAction[];
  resources: { name: string; arnFormats: string[]; conditionKeys: string[] }[];
  conditionKeys: string[];
}

interface SlimAction {
  name: string;                // "GetObject"
  level: "List" | "Read" | "Write" | "Tagging" | "Permissions management";
  resources: string[];         // resource types; [] means only "*" is allowed
  label: string;               // "Get object"
  conditionKeys: string[];
}
```

The result is 456 services and about 22,000 actions. The browser only loads `index.json` up front (36 KB, about 6 KB gzipped). Each service file is fetched the first time someone adds that service and is then cached in memory; EC2, the biggest, is 174 KB raw and about 17 KB gzipped.

### Keeping it fresh, safely

AWS adds services and actions all the time, so the data refreshes weekly through a GitHub Actions workflow. Because a bad sync could quietly break policies for everyone, it has several guardrails:

- **It fails closed.** If a curated service (S3, EC2, IAM and the other common ones) loses actions, or more than 1% of all actions arrive without an access level, the sync stops instead of publishing.
- **Deterministic output.** Keys are sorted, so a data change shows up as a meaningful diff, and a run where only the timestamp changed is treated as "no change".
- **Tested before it's proposed.** The full test suite and the production build run against the new data. Only if they pass does the workflow open a pull request with a summary of added, removed and changed services.
- **Least-privilege CI.** The job that fetches, tests and builds has a read-only token. A separate job with write access only commits the uploaded data and opens the PR; it never runs project code.
- **A human merges.** The workflow never pushes to `main`. Merging the PR is what deploys.

![The weekly data sync and the CI layers that gate every change.](/assets/blog/rolecraft-architecture/pipelines.png)

## The core model

Everything revolves around one serialisable object:

```ts src/core/model/model.ts (simplified)
interface RoleModel {
  version: 1;
  name: string;                         // validated against IAM's naming rules
  partition: "aws";
  accountId?: string;                   // optional; "*" in ARNs when missing
  region?: string;
  trust: Trust;                         // who can assume the role
  grants: Grant[];                      // one per sentence row / grid block
  policyMode: "inline" | "managed";
  managedPolicyArns: string[];
}

type Trust =
  | { kind: "service"; service: "ec2" | "lambda" | "ecs-tasks" }
  | { kind: "github"; owner: string; repo: string; ref: { type: "branch" | "tag" | "environment" | "pull_request"; value?: string } }
  | { kind: "account"; accountId: string; externalId?: string; requireMfa?: boolean }
  | { kind: "principal"; target: "group" | "user"; name: string };

interface Grant {
  id: string;
  service: string;                      // "s3"
  module?: string;                      // smart module id, when one applies
  scope: { type: "all" } | { type: "arns"; arns: string[] } | { type: "module"; data: unknown };
  access: { type: "levels"; levels: AccessLevel[] }
        | { type: "actions"; actions: string[] }
        | { type: "preset"; preset: string };
}
```

The sentence editor and the grid editor are just two views over `grants`, so switching between them never loses anything. The whole model is validated with a Zod schema at every boundary: when it's loaded from a share link, and again at the start of every generation.

## How a policy is generated

The heart of the app is one function, `generate(model, catalog)`. Every edit in the UI runs it. In order:

1. **Schema check.** Parse the model with Zod. A malformed model returns a single error and no documents.
2. **Value validation.** Role name, account ID, bucket names, regions, GitHub owner and repo. Bad values become field-level errors and never reach the engine.
3. **Build each grant.** Look up the service in the catalog. If the grant has a smart module, the module builds its statements; otherwise the **generic engine** does. A failure in one grant is caught and reported against that grant, not the whole role.
4. **Deduplicate.** Statements that are identical apart from their `Sid` collapse into one, and `Sid`s are made unique and deterministic.
5. **Validate the identity policy** (more on this below).
6. **Build and validate the trust policy.**
7. **Lint** for risky patterns.
8. **Size check** against IAM's limits (6,144 characters for a managed policy, 10,240 for inline, 2,048 for a trust policy, whitespace excluded).
9. **Sort issues** by severity: errors, then warnings, then info.

![What happens inside generate() on every edit.](/assets/blog/rolecraft-architecture/generate.png)

The output is always the same shape:

```ts src/core/generate.ts
interface GenerateResult {
  policy: PolicyDocument | null;
  trust: PolicyDocument | null;
  issues: Issue[];                      // { id, severity, message, grantId?, path? }
  sizes: { policy: number; trust: number };
}
```

Any `error` issue disables Export until it's fixed. The same input always produces byte-identical output, which matters a lot for snapshot tests and for diffs in pull requests.

## Generic engine and smart modules

The **generic engine** handles every one of the 456 services. Given access levels or individual actions, it:

- splits actions into **resource-scoped** ones and **global-only** ones (actions AWS only allows on `*`),
- builds ARNs for the scoped actions from the service's ARN formats, filling in account and region or `*`,
- puts global-only actions in their own `Resource: "*"` statement and reports why,
- never collapses to a wildcard like `s3:Get*` unless that is exactly what was selected.

Generic is correct, but some services have well-known traps that need more than "actions plus ARNs". Those get a **smart module**, ten in total: S3, EC2, ECR, EKS, Lambda, DynamoDB, CloudWatch Logs, Secrets Manager, KMS and SQS. Every module implements the same small interface:

```ts src/core/engine/modules/types.ts
interface Module<D> {
  id: string;
  service: string;
  label: string;
  presets: { id: string; label: string; actions: string[] }[];  // the sentence verbs
  dataSchema: z.ZodType<D>;                                      // module-specific scope settings
  build(grant: Grant, data: D, svc: SlimService, ctx: BuildContext): BuildResult;
  explain(grant: Grant, data: D): string;                        // "Can ..."
}
```

A shared `runModule` wrapper checks that the grant matches the module's service, that the preset exists and that the scope data passes the module's schema, before the module's `build` ever runs. Adding a module means writing one file and registering it; nothing else in the system changes.

The S3 module is a good example of why modules exist. "Can list and download files in `reports/` of `data-lake`" becomes two statements: `ListBucket` on the **bucket** with a prefix condition, and the object actions on the **objects** under the prefix:

```json policy.json (from RoleCraft's own snapshot tests)
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3ListReadList",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::data-lake",
      "Condition": { "StringLike": { "s3:prefix": ["reports/", "reports/*"] } }
    },
    {
      "Sid": "S3ListReadObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:GetObjectVersion"],
      "Resource": "arn:aws:s3:::data-lake/reports/*"
    }
  ]
}
```

Other modules encode similar rules: ECR's `GetAuthorizationToken` always goes in its own `*` statement, DynamoDB grants cover the table **and** its indexes, Lambda's deploy preset only allows `iam:PassRole` on an explicit role ARN, and EC2 scopes mutating actions by tag while `Describe*` stays on `*`.

## Trust policies

The trust builder turns `RoleModel.trust` into the assume-role policy. The GitHub Actions case is the one that matters most for security: RoleCraft always writes both the `aud` and the `sub` condition, scoped to one repository and one branch, tag, environment or pull requests:

```json trust policy (GitHub Actions)
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:omhinge/site:ref:refs/heads/main"
  }
}
```

Wildcards in the owner or repository aren't allowed at all, and a wildcard branch is a lint warning. Cross-account trust can require an External ID and MFA, and an IAM group or user gets no trust policy at all: the exports attach the policy to the principal directly.

## Validation, lint and the explainer

### A strict validator that ships to users

The validator runs in the browser on every edit, and CI runs the exact same code. It checks the generated documents, not the user's intent:

- **Structure:** version, effects, non-empty actions and resources, unique alphanumeric `Sid`s, known condition operators.
- **Action existence:** every action exists in the service data, case-sensitive.
- **Action and resource compatibility:** every ARN in a statement matches a resource type that **every** action in that statement supports. This is the check that catches the S3 bucket-versus-object mistake.
- **Condition keys:** each one is a global `aws:` key or belongs to the service, and at least one action in the statement supports it.

One rule took a while to get right: deciding which resource type an ARN *is*. `arn:aws:s3:::bucket/key` technically matches the bucket pattern too if you squint at wildcards. RoleCraft classifies an ARN as the resource type whose pattern it matches with the **most literal characters**, so an object ARN can never be accepted as a bucket ARN.

### Lint: valid isn't the same as safe

A policy can be valid and still dangerous. Nine lint rules look for that: `iam:PassRole` on `*`, `Action: "*"` or `<service>:*`, destructive or permissions-management actions on `*`, sensitive privilege-escalation actions, EC2 tag permissions that could be used to escape a tag-based scope, a GitHub OIDC provider used with SAML, unused ARNs and more. The most dangerous ones are errors that block export.

Lint also catches a subtle failure mode: some actions need several resource types (`ec2:RunInstances` needs an instance, image, subnet, security group and more). If the grant only covers some of them, the policy is *valid* but fails at runtime, so RoleCraft warns and names the missing types.

### The explainer

The explainer turns the model back into English: a "can" list ("Can list and download files in reports/ of data-lake") and a "cannot" list of destructive things the role is not allowed to do ("Cannot delete Amazon S3 resources"). The same text drives the summary in the UI and the README in the ZIP export, so what you read is what you get.

## The export layer

All exporters share one input and one output contract:

```ts src/core/export/types.ts
interface ExportInput {
  model: RoleModel;
  result: GenerateResult;
  summary: { can: { grantId: string; text: string }[]; cannot: string[] };
}

type ExportOutcome =
  | { ok: true; files: ExportFile[] }   // { filename, language, content }
  | { ok: false; reason: string };       // "Fix the errors before exporting."
```

From one `ExportInput`, `exportAll` produces:

- `policy.json` and `trust.json`
- an AWS CLI **bash** script and a **PowerShell** script
- a **Terraform** `main.tf`
- a **CloudFormation** template
- a `README.md` with the explainer text and how to apply each format
- optionally all of it as a ZIP

Each format handles the details people usually forget. EC2 roles get an instance profile. GitHub roles get an idempotent "create the OIDC provider if it's missing" step. EKS roles get the access-entry commands, with a retry for IAM propagation. The Terraform refuses to apply with credentials for the wrong account when the trust policy is tied to one.

Most of the bugs in this layer were quoting. Every user value goes through a format-specific escaper: POSIX single quotes for bash, doubled single quotes (including the Unicode variants) for PowerShell, and HCL string escaping for Terraform, where `${` has to become `$${` so a value can't turn into an interpolation.

## State, the UI and share links

The UI is React 19 with Cloudscape, AWS's own design system, so it feels like the AWS console people already know. State lives in a small Zustand store.

The key performance decision: **derive once per edit.** A single provider at the top of the builder runs `generate` and the explainer whenever the model changes, memoised, and every panel reads that one result. Early on, each output tab computed its own exports, which slowed typing down on large roles.

Sharing works without a server too. The model is compressed with `lz-string` into the URL fragment (`#s=...`). Fragments are never sent to the server, so a shared role never leaves the browsers involved. The link updates 300 ms after the last edit, is capped at 8 KB, and is validated against the schema when opened; an invalid link starts an empty builder instead of crashing.

## The APIs, end to end

Since there's no backend, the "APIs" are the contracts between the pieces:

| Interface | Shape | Used by |
| --- | --- | --- |
| AWS Service Reference | `GET /v1/service-list.json`, `GET /v1/<service>/<service>.json` | Weekly sync script only, never the browser |
| Static data | `GET /data/index.json`, `GET /data/svc/<key>.json` (1 h cache) | Catalog loader, lazily per service |
| Catalog loader | `loadIndex()`, `loadService(key)`, `loadServices(keys)`; memoised; a failed load can be retried | State layer |
| Engine | `generate(model, catalog) → GenerateResult` | Derived output, CI fixtures |
| Module | `build(grant, data, svc, ctx) → { statements, issues }` | Engine, through `runModule` |
| Explainer | `explain(model, catalog) → { can, cannot }` | Summary panel, README export |
| Exporters | `exportAll(input) → ExportOutcome` | Output tabs, ZIP |
| Share link | `encodeModel(model)`, `readModelFromHash(hash)` | Share sync, page load |

Service keys are validated (`^[a-z0-9-]{1,64}$`) before they're ever put in a URL, and every file the browser fetches comes from the same origin, which keeps the Content Security Policy simple.

## Testing: six layers, one goal

The goal is simple to say and hard to meet: **no export RoleCraft produces should fail when someone applies it.** The checks run in layers:

1. **The in-browser validator** described above, on every edit.
2. **Unit and snapshot tests:** around 940 tests with Vitest, including golden outputs for each module and snapshots of every export format for reference roles.
3. **Property-based and exhaustive tests:** fast-check generates a thousand random valid roles per property across real services and asserts the output always validates and is deterministic. A sweep builds **every service at every access level** and validates each one.
4. **Export tooling:** the real tools run on the generated files: `shellcheck`, PSScriptAnalyzer, `terraform validate`, `cfn-lint`, and a checker that parses every `aws` command against the AWS CLI's own service models.
5. **Apply tests on an emulator:** CI applies every export (bash, PowerShell, Terraform and CloudFormation) to moto, a local AWS emulator, dumps the resulting IAM state and fails if any format leaves a different state than bash. Its first run found a real bug: the CLI scripts created the managed policy without the description the other formats set.
6. **End-to-end:** Playwright drives the real UI through the main flows, and one test walks the whole builder under the production Content Security Policy and fails on any violation.

Tool versions in CI are pinned, and downloaded binaries (AWS CLI, PowerShell, shellcheck) are checked against SHA-256 checksums.

## Security

- **No credentials, no backend.** The landing page and footer say so, and the architecture enforces it.
- **A strict CSP:** `default-src 'self'`, `script-src 'self'` with no inline scripts, `frame-ancestors 'none'`, plus `nosniff` and a referrer policy.
- **Zod runs in jitless mode.** By default Zod probes `new Function` for speed, which is a violation under `script-src 'self'`. Turning that off keeps the CSP strict without weakening it.
- **Generated scripts never embed secrets.** External IDs are user-provided, and nothing is sent anywhere.

## Problems I ran into

- **The bucket-versus-object ARN ambiguity.** The first version of the validator accepted an object ARN where a bucket ARN was needed. The "most literal characters wins" rule fixed it.
- **Valid policies that still fail at runtime.** Multi-resource actions like `ec2:RunInstances` led to the partial-resource warning. Static validation alone can't catch this class of bug.
- **Emulator gaps.** moto doesn't implement EKS access entries, some CloudFormation IAM resource types or the OIDC provider. Each gap is stubbed or explicitly skipped in the comparison, with the reason written next to it, so it's never silently ignored.
- **IAM propagation.** A freshly created role can't be used in an EKS access entry for a few seconds. The scripts retry only on that specific error, so real failures still fail fast.
- **PowerShell.** Error handling for native commands differs across PowerShell versions, which made the retry logic surprisingly delicate.
- **Performance while typing.** Computing exports per tab made large roles lag. Deriving once per edit fixed it.
- **No sandbox AWS account (yet).** The plan includes running every generated policy through IAM Access Analyzer and the Policy Simulator, then applying it to a real account. I didn't have an account available for that, so the emulator layer covers apply-time behaviour for now.

## What's next

- **Checks against real AWS:** Access Analyzer's policy validation and the Policy Simulator for "this action is allowed, that one is denied" assertions, then real apply tests in a sandbox account.
- **Templates:** ready-made roles like "GitHub Actions deploys to S3" and "Lambda with a DynamoDB table". The route exists but stays hidden until the templates are verified.
- **Paste an existing policy:** import a policy you already have, see it in the grid and get a risk review.

## Takeaways

- **Keep the core pure.** Putting every decision in framework-free functions made the hard part (correctness) testable in isolation, and let CI run the same code as users.
- **Treat upstream data as untrusted.** The weekly sync fails closed, proves itself with tests and still waits for a human to merge.
- **One model, many views.** The editors, the outputs and the share link all read and write one `RoleModel`, so they can't drift apart.
- **Test what users actually do.** Applying every export to an emulator found bugs that static checks never would.

Try it at [rolecraft.omhinge.cloud](https://rolecraft.omhinge.cloud) or read the code on [GitHub](https://github.com/Aisu2635/RoleCraft). If you find a policy it gets wrong, I'd love to hear about it.
