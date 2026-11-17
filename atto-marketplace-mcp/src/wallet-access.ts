import {inspectMarketplaceWalletSetup,withUnchangedMarketplaceWalletSetup,marketplacePaymentsUsable} from '@attocash/cli/internal-marketplace';
import { defaultMarketplaceHome, managedWalletEnvironment } from './wallet-home.js';
import { readWalletSelection, saveWalletSelection, type AttoWalletAccess } from './wallet-preferences.js';
import { ProfileError } from './profile-store.js';
import {ensurePrivateDirectory} from './private-directory.js';
import { requireSetupTerminal, terminalPrompt, yesNo, type Prompt } from './terminal-input.js';
import { takeJsonFlag, terminalFields, terminalText, writeTerminalResult } from './terminal-output.js';

interface AttoStatus {
  initialized: boolean;
  identity: { fingerprint: string } | null;
  settings: { network: string };
  addresses: { index: number; address: string }[];
  mcpAccess: string;
  pool: { indexes: number[] };
}

function statusValue(value: unknown): AttoStatus {
  const status = value as AttoStatus;
  if (!status?.initialized || !status.identity || typeof status.identity.fingerprint !== 'string'
    || !status.settings || !['LIVE','BETA','DEV','LOCAL'].includes(status.settings.network)
    || !Array.isArray(status.addresses) || !Array.isArray(status.pool?.indexes)
    || !['read-only','spend'].includes(status.mcpAccess)) throw setupRequired();
  return status;
}

export function selectedAttoWallet(env: NodeJS.ProcessEnv, value: unknown): {
  address: string; index: number; network: string;
  permissions: { externalTransfers: boolean; receive: boolean };
} {
  const status = statusValue(value);
  const selection = env.MARKETPLACE_MCP_HOME ? readWalletSelection(env.MARKETPLACE_MCP_HOME) : undefined;
  const access = selection?.attoAccess;
  if (!access || selection?.attoDirectory !== env.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR
    || access.fingerprint !== status.identity!.fingerprint
    || access.network !== `atto:${status.settings.network.toLowerCase()}`
    || !status.addresses.some(account => account.index === access.index && account.address === access.address)) throw setupRequired();
  const writable = status.mcpAccess === 'spend' && status.pool.indexes.includes(access.index);
  const externalTransfers = writable && access.externalTransfers;
  return { address: access.address, index: access.index, network: access.network,
    permissions: { externalTransfers, receive: externalTransfers } };
}

/** Re-read the narrower Marketplace grant at every native admission and signing check. */
export function assertAttoWalletWrite(env: NodeJS.ProcessEnv, status: unknown,
  operation: 'transfer.send' | 'receive'): void {
  const { permissions } = selectedAttoWallet(env, status);
  const allowed = operation === 'transfer.send' ? permissions.externalTransfers : permissions.receive;
  if (!allowed) throw new ProfileError('PERMISSION_DENIED', 'This operation requires local terminal approval for the selected Marketplace wallet.');
}

/** Terminal-owned purpose grants narrow the existing CLI authority without replacing it. */
export async function approveAttoWalletAccess(options: {
  home: string; directory: string; index: number; prompt?: Prompt;
  grants?: { externalTransfers: boolean };
  json?: boolean;
}): Promise<void> {
  requireSetupTerminal();
  const prompt = options.prompt ?? terminalPrompt;
  const beforeSelection = readWalletSelection(options.home);
  const before = await inspectMarketplaceWalletSetup({directory:options.directory,index:options.index});
  const previous = beforeSelection?.attoDirectory === options.directory
    && beforeSelection.attoAccess?.fingerprint === before.fingerprint
    && beforeSelection.attoAccess.index === options.index
    && beforeSelection.attoAccess.network === before.network ? beforeSelection.attoAccess : undefined;
  const externalTransfers = options.grants?.externalTransfers
    ?? await yesNo(prompt, 'Allow external Atto transfers from this wallet', previous?.externalTransfers ?? false);
  if(externalTransfers&&!marketplacePaymentsUsable(before))throw new ProfileError('WALLET_SETUP_REQUIRED','Payment access requires native spend access and the selected account in the payment pool. Run wallet setup first.');
  const access: AttoWalletAccess = { address: before.address, index: before.index,
    network: before.network, fingerprint: before.fingerprint, externalTransfers };
  const review = {directory: options.directory, ...access, limits:before.formattedLimits};
  process.stderr.write(`${options.json ? JSON.stringify(review, null, 2) : terminalFields({wallet:before.address,index:before.index,network:before.network,externalTransfers,limits:before.formattedLimits})}\n`
    + 'Marketplace grants narrow this wallet’s existing CLI permissions and shared spending limits.\n'
    + (externalTransfers?'Enable payments for this selected wallet and account within these saved limits.\n':''));
  if (await prompt('Type APPROVE to save this Marketplace wallet access: ') !== 'APPROVE') {
    throw new ProfileError('APPROVAL_DECLINED', 'Marketplace wallet access approval was declined.');
  }
  requireSetupTerminal();
  await withUnchangedMarketplaceWalletSetup({directory:before.directory,index:before.index,expected:before,terminalConfirmed:true},
    ()=>saveWalletSelection(options.home,{attoDirectory:options.directory,attoAccess:access},{expected:beforeSelection}));
}

export async function runAttoWalletAccessCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const output = takeJsonFlag(argv);
  argv = output.argv;
  const command = argv[0];
  const flags = new Set<string>();
  let home: string | undefined;
  let assetSeen = false;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--asset' && !assetSeen && argv[index + 1] === 'ATTO') { assetSeen = true; index++; continue; }
    if (arg === '--home' && !home && argv[index + 1]) { home = argv[++index]; continue; }
    if (command === 'policy' && ['--allow-external-transfers'].includes(arg ?? '') && !flags.has(arg!)) { flags.add(arg!); continue; }
    throw setupRequired();
  }
  if (!assetSeen) throw setupRequired();
  const selected = managedWalletEnvironment(home ?? env.MARKETPLACE_MCP_HOME ?? defaultMarketplaceHome(env), env);
  const selection = readWalletSelection(selected.MARKETPLACE_MCP_HOME!);
  if (!selection?.attoAccess || selection.attoDirectory !== selected.MARKETPLACE_MCP_ATTO_WALLET_DATA_DIR) throw setupRequired();
  if (command === 'policy') {
    await approveAttoWalletAccess({ home: selected.MARKETPLACE_MCP_HOME!,
      directory: selection.attoDirectory!, index: selection.attoAccess.index,
      grants: { externalTransfers: flags.has('--allow-external-transfers') }, json: output.json });
  } else if (command !== 'status') throw setupRequired();
  const { callWallet } = await import('./wallet-process.js');
  writeTerminalResult(await callWallet(selected, {asset: 'ATTO', operation: 'identity.list', input: {}}), output.json);
}

function setupRequired(): ProfileError {
  return new ProfileError('WALLET_SETUP_REQUIRED', 'Configure the selected Atto account and Marketplace wallet permissions in the local terminal.');
}
