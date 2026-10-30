/** The fixture's token (serve.mjs writes the same into its state dir). */
export declare const e2eToken: (fixture: string) => string;
export declare const e2eCredential: (token: string, port: number) => string;
/** A Playwright storage state holding the login cookie of `fixture`'s server. */
export declare function loggedIn(fixture: string, port: number): {
    cookies: {
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: 'Strict';
    }[];
    origins: never[];
};
