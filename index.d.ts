// Type surface for TypeScript consumers. The plugin is authored in plain ESM.
export declare const name: string
export declare const inject: string[]
export declare const Config: unknown
export declare function apply(ctx: any, config: any): void
export declare function credentialStatus(ctx: any, ref: string): Promise<{ configured: boolean }>
