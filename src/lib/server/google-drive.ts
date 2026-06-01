import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import {
  GOOGLE_DRIVE_CLIENT_ID,
  GOOGLE_DRIVE_CLIENT_SECRET,
  GOOGLE_DRIVE_PARENT_FOLDER_ID,
  GOOGLE_DRIVE_REFRESH_TOKEN,
  GOOGLE_DRIVE_REDIRECT_URI,
} from "@/lib/config";
import { slugify } from "@/lib/utils";
import { getRun, setRunDriveFolder } from "./repository";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

type DriveClient = ReturnType<typeof google.drive>;

export type DriveUploadResult = {
  driveFileId: string;
  driveFolderId: string;
  driveWebViewLink: string | null;
};

function hasDriveConfig() {
  return Boolean(
    GOOGLE_DRIVE_PARENT_FOLDER_ID &&
      GOOGLE_DRIVE_CLIENT_ID &&
      GOOGLE_DRIVE_CLIENT_SECRET &&
      GOOGLE_DRIVE_REFRESH_TOKEN,
  );
}

function createDriveClient(): DriveClient | null {
  if (!hasDriveConfig()) {
    return null;
  }

  const clientId = GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = GOOGLE_DRIVE_REFRESH_TOKEN;
  const redirectUri = GOOGLE_DRIVE_REDIRECT_URI ?? "https://developers.google.com/oauthplayground";

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth });
}

function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findChildByName(input: {
  drive: DriveClient;
  parentFolderId: string;
  name: string;
  mimeType?: string;
}) {
  const escapedName = escapeDriveQueryValue(input.name);
  const clauses = [
    `'${input.parentFolderId}' in parents`,
    `name = '${escapedName}'`,
    "trashed = false",
  ];

  if (input.mimeType) {
    clauses.push(`mimeType = '${input.mimeType}'`);
  }

  const response = await input.drive.files.list({
    q: clauses.join(" and "),
    fields: "files(id,name,webViewLink)",
    spaces: "drive",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return response.data.files?.[0] ?? null;
}

async function ensureRunFolder(input: {
  drive: DriveClient;
  runId: string;
  runLabel: string;
}) {
  const run = getRun(input.runId);
  if (run?.driveFolderId) {
    return run.driveFolderId;
  }

  if (!GOOGLE_DRIVE_PARENT_FOLDER_ID) {
    throw new Error("GOOGLE_DRIVE_PARENT_FOLDER_ID is not configured.");
  }

  const folderName = `${input.runLabel || "Run"} - ${input.runId}`;
  const existing = await findChildByName({
    drive: input.drive,
    parentFolderId: GOOGLE_DRIVE_PARENT_FOLDER_ID,
    name: folderName,
    mimeType: FOLDER_MIME_TYPE,
  });

  if (existing?.id) {
    setRunDriveFolder(input.runId, existing.id);
    return existing.id;
  }

  const created = await input.drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: FOLDER_MIME_TYPE,
      parents: [GOOGLE_DRIVE_PARENT_FOLDER_ID],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  if (!created.data.id) {
    throw new Error("Google Drive did not return a folder ID.");
  }

  setRunDriveFolder(input.runId, created.data.id);
  return created.data.id;
}

export async function uploadRenderedClipToDrive(input: {
  runId: string;
  runLabel: string;
  outputPath: string;
}) {
  const drive = createDriveClient();
  if (!drive) {
    return null;
  }

  const driveFolderId = await ensureRunFolder({
    drive,
    runId: input.runId,
    runLabel: input.runLabel,
  });
  const fileName = `${slugify(path.basename(input.outputPath, path.extname(input.outputPath)))}.mp4`;
  const existing = await findChildByName({
    drive,
    parentFolderId: driveFolderId,
    name: fileName,
  });
  const media = {
    mimeType: "video/mp4",
    body: fs.createReadStream(input.outputPath),
  };

  if (existing?.id) {
    const updated = await drive.files.update({
      fileId: existing.id,
      media,
      fields: "id,webViewLink",
      supportsAllDrives: true,
    });

    return {
      driveFileId: updated.data.id ?? existing.id,
      driveFolderId,
      driveWebViewLink: updated.data.webViewLink ?? existing.webViewLink ?? null,
    } satisfies DriveUploadResult;
  }

  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [driveFolderId],
    },
    media,
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });

  if (!created.data.id) {
    throw new Error("Google Drive did not return a file ID.");
  }

  return {
    driveFileId: created.data.id,
    driveFolderId,
    driveWebViewLink: created.data.webViewLink ?? null,
  } satisfies DriveUploadResult;
}
