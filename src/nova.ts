#!/usr/bin/env tsx
import { z } from "zod/v4";
import { v7 } from "uuid";
import { exit } from "node:process";
import assert from "node:assert";

type UserId = string;
type ReferenceId = string;
type CC = string;

type Card = {
    id: ReferenceId;
    value: CC;
    user_id: UserId;
};

const sessions = new Map<string, UserId>([]);
const ccMap = new Map<CC, ReferenceId>();
const tokenizerCache = new Map<ReferenceId, CC>();
const userMap = new Map<string, Card[]>();

const createSensitive = z.object({
    cc: z.string()
});

type ReferenceResponse = {
    id: ReferenceId;
};

type Request = { headers: Record<string, string>; body: unknown } & Record<
    string,
    unknown
>;

// Endpoint handler
const userHandler = async (
    req: Request,
): Promise<{ id: ReferenceId } | { message: string }> => {
    const userId = checkIfAuth(req.headers);

    if (!userId) {
        // 401 unauthorized
        return {
            message: "Unauthorized",
        };
    }

    const parsed = createSensitive.parse(req.body);

    const details = await getOrInsertCreditCard({ ...parsed, userId });

    return {
        id: details.id,
    };
};

const parseAuthHeader = (
    headers: Record<string, string>,
): string | undefined => {
    const authHeader = headers.Authorization;

    if (!authHeader) return undefined;

    // Bearer <Token>
    const [_, token] = authHeader.split(" ");

    if (!token) {
        return undefined;
    }
    return token;
};

const checkIfAuth = (headers: Record<string, string>): string | undefined => {
    const token = parseAuthHeader(headers);

    if (!token) {
        return undefined;
    }

    const session = sessions.get(token);

    return session;
};

const getOrInsertCreditCard = async (
    data: z.infer<typeof createSensitive> & { userId: string },
): Promise<ReferenceResponse> => {
    const existing = await getCard(data);

    if (existing) {
        return {
            id: existing,
        };
    }

    const insert = await insertCard(data);

    return {
        id: insert,
    };
};

const getCard = async (
    data: z.infer<typeof createSensitive>,
): Promise<ReferenceId | undefined> => {
    return ccMap.get(data.cc);
};

const insertCard = async (
    data: z.infer<typeof createSensitive> & { userId: string },
): Promise<ReferenceId> => {
    const newRecord = {
        id: v7(),
        value: data.cc,
        user_id: data.userId,
    };

    const existing = userMap.get(data.userId) ?? [];

    userMap.set(data.userId, [...existing, newRecord]);
    ccMap.set(data.cc, newRecord.id);
    tokenizerCache.set(newRecord.id, data.cc);

    return newRecord.id;
};

/// START OF M2M
// Endpoint handler

type M2mToken = string;
const m2mMap = new Set<M2mToken>(["019a07cd-16a9-7acf-9ed4-cc9c19bc13c4"]);

const tokenizerPayload = z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    user_id: z.string(),
    method: z.string(),
    args: z.string(),
});

const m2mHandler = async (
    req: Request,
): Promise<{ result: unknown } | { message: string }> => {
    const isAuthed = await checkIfM2mAuthed(req.headers);

    if (!isAuthed) {
        // 401 unauthorized
        return {
            message: "Unauthorized",
        };
    }

    const parsed = tokenizerPayload.parse(req.body);

    let transformed = parsed.args;

    const relevantReferences = userMap.get(parsed.user_id) ?? [];

    // Note; Consider performance
    for (const reference of relevantReferences) {
        transformed = transformed.replaceAll(reference.id, reference.value);
    }



    let response = await fetchThirdParty(parsed, transformed);

    if (typeof response !== "string") {
        return {
            message: response.message,
        };
    }

    for (const reference of relevantReferences) {
        response = response.replaceAll(reference.value, reference.id);
    }

    return {
        result: response,
    };
};

const checkIfM2mAuthed = async (
    headers: Record<string, string>,
): Promise<boolean> => {
    const token = parseAuthHeader(headers);

    if (!token) {
        return false;
    }

    return m2mMap.has(token);
};

const fetchThirdParty = async (
    parsed: z.infer<typeof tokenizerPayload>,
    transformedPayload: string,
): Promise<string | { status: number; message: string }> => {
    if (parsed.url === "http://example.com") {
        return JSON.stringify({
            cc: "4964497461456992",
            name: "example",
        });
    }

    const response = await fetch(parsed.url, {
        method: parsed.method,
        headers: parsed.headers,
        body: transformedPayload,
    });

    if (!response.ok) {
        return {
            status: response.status,
            message: response.statusText,
        };
    }

    const body = await response.text();

    return body;
};

const main = async () => {
    // User flow -> Creating an application with no token, expected: Unauthorized
    const userFlow1 = {
        cc: "4964497461456992",
    };

    let result = await userHandler({
        headers: {
            Authorization: "Bearer ",
        },
        body: userFlow1,
    });

    assert(result.message === "Unauthorized");

    // User flow -> Creating an application with token, expected: card created
    const userFlow2 = {
        cc: "4964497461456993",
    };
    const token = v7();
    const user = v7();

    sessions.set(token, user);

    result = await userHandler({
        headers: {
            Authorization: `Bearer ${token}`,
        },
        body: userFlow2,
    });

    assert(Boolean(result.id), "id should be present");

    const ccEntry = ccMap.get(userFlow2.cc);

    assert(ccEntry === result.id, "Should return reference id");

    const tokenMap = tokenizerCache.get(result.id);

    assert(tokenMap === userFlow2.cc, "Should return cc");

    // M2m Flow -> Request tokenizer
    const userEx = sessions.get(token);

    const m2mFlow1 = {
        url: "http://example.com",
        headers: {
            Authorization: "Bearer test",
            "Content-Type": "application/json",
        },
        user_id: userEx,
        method: "POST",
        args: JSON.stringify({
            reference_id: result.id,
        }),
    } satisfies z.infer<typeof tokenizerPayload>;

    const response = await m2mHandler({
        headers: {
            Authorization: "Bearer 019a07cd-16a9-7acf-9ed4-cc9c19bc13c4",
        },
        body: m2mFlow1,
    });


};

main()
    .then(() => {
        console.log("DONE");
    })
    .catch((e) => {
        console.error(e);
        exit(-1);
    });
