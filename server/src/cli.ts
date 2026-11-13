/** Administration en ligne de commande : creation d'admin, reinitialisation, sauvegarde. Usage : node dist/cli.js <commande> */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.js';
import { AuthService, HttpError } from './auth.js';
import { Audit } from './audit.js';

const dataDir = process.env['DATA_DIR'];
if (!dataDir) { console.error('DATA_DIR est obligatoire'); process.exit(2); }
const [cmd, ...args] = process.argv.slice(2);

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    return new Promise((res) => rl.once('line', (l) => { rl.close(); res(l); }));
  }
  const muted = new Writable({ write(_c, _e, cb) { cb(); } });
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((res) => rl.question('', (a) => { rl.close(); process.stdout.write('\n'); res(a); }));
}

const db = openDb(dataDir);
const auth = new AuthService(db);
const audit = new Audit(db);
try {
  switch (cmd) {
    case 'create-admin': {
      const [username, email] = args;
      if (!username) throw new Error('Usage : create-admin <identifiant> [email]');
      const pw = await promptHidden('Mot de passe (12 caracteres minimum) : ');
      const u = await auth.createUser({ username, email: email ?? null, password: pw, role: 'admin' });
      audit.log({ actorType: 'system', action: 'user.create_admin_cli', target: u.id });
      console.log(`Administrateur cree : ${u.username}`);
      break;
    }
    case 'reset-token': {
      const [username] = args;
      const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username ?? '') as { id: string } | undefined;
      if (!row) throw new Error('Utilisateur introuvable');
      console.log(`Jeton (valable 30 minutes, usage unique) : ${auth.issueResetToken(row.id)}`);
      audit.log({ actorType: 'system', action: 'user.reset_token_cli', target: row.id });
      break;
    }
    case 'list-users':
      for (const u of auth.listUsers()) console.log(`${u.username}\t${u.role}\t${u.disabled ? 'desactive' : 'actif'}`);
      break;
    case 'backup': {
      const [dest] = args;
      if (!dest) throw new Error('Usage : backup <fichier-destination>');
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      chmodSync(dest, 0o600);
      console.log(`Sauvegarde ecrite : ${dest}`);
      break;
    }
    default:
      console.error('Commandes : create-admin <identifiant> [email] | reset-token <identifiant> | list-users | backup <fichier>');
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof HttpError || e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  db.close();
}
