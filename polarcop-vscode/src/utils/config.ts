import * as vscode from 'vscode';
import * as os from 'os';

export interface PolarCopConfig {
  serverUrl: string;
  entryType: 'ide' | 'web';
  userId: string;
}

export function getConfig(): PolarCopConfig {
  const config = vscode.workspace.getConfiguration('polarcop');
  return {
    serverUrl: config.get<string>('serverUrl', 'http://localhost:3910'),
    entryType: config.get<'ide' | 'web'>('entryType', 'ide'),
    userId: config.get<string>('userId', '') || os.userInfo().username
  };
}

export function validateServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
