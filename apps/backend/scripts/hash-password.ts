/**
 * Generates the bcrypt hash for DEMO_USER_PASSWORD_HASH.
 *
 *   bun run scripts/hash-password.ts 'demo-password'
 *   printf '%s' 'demo-password' | bun run scripts/hash-password.ts
 *
 * This script is the reason `SALT_ROUNDS` and the `bcrypt` dependency are
 * honestly justified rather than vestigial: there is no database and no
 * registration flow, so without it the only way to configure a demo user
 * would be to put a plaintext password in `.env`.
 *
 * It deliberately does NOT import `src/env.ts`. That schema requires
 * DEMO_USER_PASSWORD_HASH, so a script whose job is to produce that value
 * could never run before it existed. Reading SALT_ROUNDS directly is the
 * narrow, documented exception to validating configuration in one place.
 */
import bcrypt from 'bcrypt';

const DEFAULT_SALT_ROUNDS = 10;

function readSaltRounds(): number {
  const raw = process.env.SALT_ROUNDS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SALT_ROUNDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 4 || parsed > 15) {
    console.error(
      `SALT_ROUNDS must be an integer between 4 and 15; got ${JSON.stringify(raw)}.`,
    );
    process.exit(1);
  }
  return parsed;
}

async function readPassword(): Promise<string> {
  const fromArgv = process.argv[2];
  if (fromArgv !== undefined && fromArgv !== '') {
    // A password passed as an argument is visible in shell history and in the
    // process table for as long as the command runs. Fine for a demo
    // credential, worth saying out loud so the habit does not travel.
    console.error(
      'Note: reading the password from argv — it will land in your shell history.',
    );
    console.error('      Pipe it on stdin instead to avoid that.\n');
    return fromArgv;
  }

  if (process.stdin.isTTY) {
    console.error("Usage: bun run scripts/hash-password.ts '<password>'");
    console.error('   or: printf %s \'<password>\' | bun run scripts/hash-password.ts');
    process.exit(1);
  }

  return (await new Response(process.stdin).text()).replace(/\r?\n$/, '');
}

const password = await readPassword();
if (password === '') {
  console.error('Refusing to hash an empty password.');
  process.exit(1);
}

const saltRounds = readSaltRounds();
const hash = await bcrypt.hash(password, saltRounds);

// The hash goes to stdout alone so the value can be piped or captured; the
// surrounding explanation goes to stderr.
console.error(`bcrypt cost ${saltRounds}, hash ${hash}`);
console.error('\nCopy this line into apps/backend/.env:\n');

/**
 * Emitted base64-encoded, and that is not cosmetic.
 *
 * A bcrypt hash starts with `$2b$10$`, and Bun's dotenv loader expands `$VAR`
 * in `.env` whatever the quoting — so a raw hash silently arrives 20
 * characters long and every login fails with "incorrect password". Backslash
 * escaping is the only thing Bun honours, but Docker's `--env-file` passes
 * escapes through literally, so a file written that way breaks in the
 * container instead. Base64 is byte-identical through both, and through an
 * injected secret where nothing parses the value at all.
 *
 * Emitting the encoded form here means nobody has to know any of that.
 */
const encoded = Buffer.from(hash, 'utf8').toString('base64');
console.log(`DEMO_USER_PASSWORD_HASH_B64=${encoded}`);
