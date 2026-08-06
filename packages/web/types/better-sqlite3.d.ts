declare module "better-sqlite3" {
  interface Database {
    prepare<BindParameters extends unknown[] = unknown[]>(source: string): Statement<BindParameters>;
    exec(source: string): this;
    close(): this;
    // Add other methods as needed
  }

  interface Statement<BindParameters extends unknown[]> {
    run(...params: BindParameters): { changes: number; lastInsertRowid: number | bigint };
    get(...params: BindParameters): unknown;
    all(...params: BindParameters): unknown[];
  }

  interface DatabaseConstructor {
    new (filename?: string | Buffer, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }): Database;
    (filename?: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }): Database;
  }

  const Database: DatabaseConstructor;
  export = Database;
  export default Database;
}