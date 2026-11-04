import "server-only";
import { getDb } from "@careerflow/db";

export const db = () => getDb();
