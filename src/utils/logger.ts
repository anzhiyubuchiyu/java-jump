/**
 * 日志工具
 */

import * as vscode from 'vscode';

export enum LogLevel {
  None = 0,
  Error = 1,
  Warning = 2,
  Info = 3,
  Debug = 4
}

export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;
  private logLevel: LogLevel = LogLevel.Info;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Java Jump');
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  initializeFromConfig(): void {
    const config = vscode.workspace.getConfiguration('javaNavigator');
    const level = config.get<string>('logLevel', 'info');
    this.logLevel = Logger.parseLogLevel(level);
  }

  private log(level: LogLevel, message: string, ...args: any[]): void {
    if (level > this.logLevel) return;

    const prefix = `[${new Date().toISOString()}] [${LogLevel[level]}]`;
    const fn = level <= LogLevel.Error ? console.error :
               level <= LogLevel.Warning ? console.warn :
               level <= LogLevel.Info ? console.log : console.debug;
    
    fn(`${prefix} ${message}`, ...args);
    this.outputChannel.appendLine(`${prefix} ${message} ${args.map(a => String(a)).join(' ')}`);
  }

  error(message: string, ...args: any[]): void {
    this.log(LogLevel.Error, message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log(LogLevel.Warning, message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.log(LogLevel.Info, message, ...args);
  }

  debug(message: string, ...args: any[]): void {
    this.log(LogLevel.Debug, message, ...args);
  }

  show(): void {
    this.outputChannel.show();
  }

  registerConfigListener(): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('javaNavigator.logLevel')) {
        const config = vscode.workspace.getConfiguration('javaNavigator');
        const level = config.get<string>('logLevel', 'info');
        this.logLevel = Logger.parseLogLevel(level);
      }
    });
  }

  private static parseLogLevel(level: string | undefined): LogLevel {
    if (!level) {
      return LogLevel.Info;
    }

    const normalized = level.trim().toLowerCase();

    switch (normalized) {
      case 'none':
        return LogLevel.None;
      case 'error':
        return LogLevel.Error;
      case 'warning':
        return LogLevel.Warning;
      case 'info':
        return LogLevel.Info;
      case 'debug':
        return LogLevel.Debug;
      default:
        return LogLevel.Info;
    }
  }
}
