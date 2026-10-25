// Checks and renews the temporary AWS credentials in AWS_CREDENTIALS_FILE (used for Amazon Bedrock).
//   npm run aws:check             is the token valid right now? (never prints secrets)
//   npm run aws:renew             check, then fetch fresh credentials with STS AssumeRole and rewrite the file
//   npm run aws:renew -- --watch  renew every AWS_RENEW_MINUTES (default 40) while the process runs
//
// Renewal needs a CURRENTLY VALID session whose role may assume itself (set AWS_RENEW_ROLE_ARN to the role to
// assume if it cannot be derived). A role session lasts at most 1 hour but can be chained, so a --watch loop started
// before the token expires keeps it alive. An EXPIRED token cannot renew itself: paste fresh credentials from the
// workshop event page into the file once, then start --watch.
import fs from "node:fs";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { awsClientConfig, readAwsCredentialsFile } from "../src/config.js";

const file = process.env.AWS_CREDENTIALS_FILE;
if (!file) throw new Error("AWS_CREDENTIALS_FILE is not set in .env");
const sts = new STSClient(awsClientConfig());

async function whoAmI(): Promise<{ arn: string; account: string } | { error: string }> {
  try {
    const r = await sts.send(new GetCallerIdentityCommand({}));
    return { arn: r.Arn!, account: r.Account! };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** arn:aws:sts::123:assumed-role/RoleName/session  ->  arn:aws:iam::123:role/RoleName */
function roleFromIdentity(arn: string): string | null {
  const m = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//.exec(arn);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : null;
}

function writeCredentials(c: { accessKeyId: string; secretAccessKey: string; sessionToken: string }, region: string) {
  const text = [
    `$Env:AWS_DEFAULT_REGION="${region}"`,
    `$Env:AWS_ACCESS_KEY_ID="${c.accessKeyId}"`,
    `$Env:AWS_SECRET_ACCESS_KEY="${c.secretAccessKey}"`,
    `$Env:AWS_SESSION_TOKEN="${c.sessionToken}"`,
    "",
  ].join("\r\n");
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file!); // atomic: a reader never sees a half-written file
}

async function renewOnce(): Promise<boolean> {
  const me = await whoAmI();
  if ("error" in me) {
    console.log(`Credentials are not valid: ${me.error}`);
    console.log("An expired token cannot renew itself. Paste fresh credentials from the workshop event page into the file, then run this again.");
    return false;
  }
  console.log(`Valid. Account ${me.account}, identity ${me.arn.replace(/\/[^/]*$/, "/<session>")}`);
  if (process.argv.includes("--check")) return true;

  const roleArn = process.env.AWS_RENEW_ROLE_ARN ?? roleFromIdentity(me.arn);
  if (!roleArn) {
    console.log("Cannot tell which role to assume from this identity. Set AWS_RENEW_ROLE_ARN in .env.");
    return false;
  }
  try {
    const r = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `renew-${Date.now()}`, DurationSeconds: 3600 }));
    const c = r.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) throw new Error("STS returned no credentials");
    writeCredentials(
      { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
      readAwsCredentialsFile().AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1",
    );
    console.log(`Renewed. New credentials written to ${file}, valid until ${c.Expiration?.toISOString()}.`);
    return true;
  } catch (e) {
    console.log(`Renewal failed: ${e instanceof Error ? e.message : String(e)}`);
    console.log("If this role cannot assume itself, renew by pasting fresh credentials from the workshop event page.");
    return false;
  }
}

if (process.argv.includes("--watch")) {
  const minutes = Number(process.env.AWS_RENEW_MINUTES ?? 40);
  console.log(`Renewing every ${minutes} min. Ctrl+C to stop.`);
  for (;;) {
    await renewOnce();
    await new Promise((r) => setTimeout(r, minutes * 60_000));
  }
} else {
  process.exit((await renewOnce()) ? 0 : 1);
}
