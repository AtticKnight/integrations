/** Public local intent is persisted only to rebuild a review after interruption. */
export type WalletAccessMode='login-only'|'limited'|'unlimited';
export interface WalletSetupIdentity {directory:string;address:string;index:number;network:string}
export interface DeferredWalletPlan {
  asset:'ATTO'|'XNO';
  wallet:WalletSetupIdentity;
  mode:WalletAccessMode;
  review:string;
  intent:Record<string,unknown>;
  validate():Promise<void>;
  commit():Promise<WalletSetupIdentity>;
}
