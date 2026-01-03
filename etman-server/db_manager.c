/**
 * @file db_manager.c
 * @brief PostgreSQL database connection manager implementation
 *
 * Provides database connectivity for sound metadata storage using libpq.
 */

#include "db_manager.h"
#include "sound_manager.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libpq-fe.h>

/*
 * Module state
 */
static struct {
    PGconn     *conn;
    DBStatus    status;
    char        lastError[256];
    char        connString[512];
} g_db;

/*
 * Helper: Set error message
 */
static void setError(const char *msg) {
    strncpy(g_db.lastError, msg, sizeof(g_db.lastError) - 1);
    g_db.lastError[sizeof(g_db.lastError) - 1] = '\0';
}

/*
 * Helper: Set error from PG connection
 */
static void setErrorFromPG(void) {
    if (g_db.conn) {
        const char *err = PQerrorMessage(g_db.conn);
        if (err && err[0]) {
            setError(err);
        }
    }
}

/*
 * Helper: Check result and handle errors
 */
static bool checkResult(PGresult *res, ExecStatusType expected) {
    if (!res) {
        setErrorFromPG();
        return false;
    }

    ExecStatusType status = PQresultStatus(res);
    if (status != expected) {
        const char *err = PQresultErrorMessage(res);
        if (err && err[0]) {
            setError(err);
        } else {
            setError(PQresStatus(status));
        }
        PQclear(res);
        return false;
    }

    return true;
}

/*
 * Helper: Parse timestamp from string
 */
static time_t parseTimestamp(const char *str) {
    if (!str || !str[0]) return 0;

    struct tm tm = {0};
    /* PostgreSQL format: "2024-12-27 10:30:00" or "2024-12-27 10:30:00.123456" */
    if (sscanf(str, "%d-%d-%d %d:%d:%d",
               &tm.tm_year, &tm.tm_mon, &tm.tm_mday,
               &tm.tm_hour, &tm.tm_min, &tm.tm_sec) >= 6) {
        tm.tm_year -= 1900;
        tm.tm_mon -= 1;
        return mktime(&tm);
    }
    return 0;
}

/*
 * Helper: Safe string copy
 */
static void safeStrCopy(char *dest, const char *src, size_t destSize) {
    if (!src) {
        dest[0] = '\0';
        return;
    }
    strncpy(dest, src, destSize - 1);
    dest[destSize - 1] = '\0';
}

/*
 * Helper: Get field value with null check
 */
static const char* getField(PGresult *res, int row, int col) {
    if (PQgetisnull(res, row, col)) {
        return "";
    }
    return PQgetvalue(res, row, col);
}

/*
 * Helper: Get integer field
 */
static int getIntField(PGresult *res, int row, int col) {
    const char *val = getField(res, row, col);
    return val[0] ? atoi(val) : 0;
}

/*
 * Helper: Get boolean field
 */
static bool getBoolField(PGresult *res, int row, int col) {
    const char *val = getField(res, row, col);
    return val[0] == 't' || val[0] == 'T' || val[0] == '1';
}


/*
 * Database connection API
 */

bool DB_Init(const char *connString) {
    memset(&g_db, 0, sizeof(g_db));
    g_db.status = DB_STATUS_DISCONNECTED;

    /* Get connection string from parameter or environment */
    if (connString && connString[0]) {
        strncpy(g_db.connString, connString, sizeof(g_db.connString) - 1);
    } else {
        const char *envUrl = getenv("DATABASE_URL");
        if (!envUrl || !envUrl[0]) {
            setError("DATABASE_URL environment variable not set");
            g_db.status = DB_STATUS_ERROR;
            return false;
        }
        strncpy(g_db.connString, envUrl, sizeof(g_db.connString) - 1);
    }

    g_db.status = DB_STATUS_CONNECTING;

    /* Connect to PostgreSQL */
    g_db.conn = PQconnectdb(g_db.connString);
    if (PQstatus(g_db.conn) != CONNECTION_OK) {
        setErrorFromPG();
        g_db.status = DB_STATUS_ERROR;
        fprintf(stderr, "DB_Init: Connection failed: %s\n", g_db.lastError);
        PQfinish(g_db.conn);
        g_db.conn = NULL;
        return false;
    }

    g_db.status = DB_STATUS_CONNECTED;
    printf("DB_Init: Connected to PostgreSQL\n");

    return true;
}

void DB_Shutdown(void) {
    if (g_db.conn) {
        PQfinish(g_db.conn);
        g_db.conn = NULL;
    }
    g_db.status = DB_STATUS_DISCONNECTED;
    printf("DB_Shutdown: Disconnected from PostgreSQL\n");
}

bool DB_IsConnected(void) {
    if (!g_db.conn) return false;
    return PQstatus(g_db.conn) == CONNECTION_OK;
}

DBStatus DB_GetStatus(void) {
    return g_db.status;
}

const char* DB_GetLastError(void) {
    return g_db.lastError;
}

bool DB_Reconnect(void) {
    if (g_db.conn) {
        PQreset(g_db.conn);
        if (PQstatus(g_db.conn) == CONNECTION_OK) {
            g_db.status = DB_STATUS_CONNECTED;
            return true;
        }
    }

    /* Full reconnect */
    DB_Shutdown();
    return DB_Init(g_db.connString);
}

PGconn* DB_GetConnection(void) {
    if (!DB_IsConnected()) return NULL;
    return g_db.conn;
}


/*
 * Sound file operations
 */

bool DB_AddSound(const char *guid, const char *alias,
                 const char *filename, const char *originalName,
                 const char *filePath, int fileSize, int durationSeconds,
                 int *outSoundFileId) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Use a transaction for atomicity */
    PGresult *res = PQexec(g_db.conn, "BEGIN");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    /* Insert into sound_files */
    const char *insertFileParams[7] = {
        filename, originalName, filePath,
        NULL, NULL, guid, NULL  /* fileSize, durationSeconds, referenceCount */
    };
    char fileSizeStr[16], durationStr[16];
    snprintf(fileSizeStr, sizeof(fileSizeStr), "%d", fileSize);
    snprintf(durationStr, sizeof(durationStr), "%d", durationSeconds);
    insertFileParams[3] = fileSizeStr;
    insertFileParams[4] = durationStr;

    res = PQexecParams(g_db.conn,
        "INSERT INTO sound_files (filename, original_name, file_path, file_size, "
        "duration_seconds, added_by_guid, reference_count, is_public) "
        "VALUES ($1, $2, $3, $4, $5, $6, 1, false) RETURNING id",
        6, NULL, insertFileParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }

    int soundFileId = atoi(PQgetvalue(res, 0, 0));
    PQclear(res);

    if (outSoundFileId) {
        *outSoundFileId = soundFileId;
    }

    /* Insert into user_sounds */
    char soundFileIdStr[16];
    snprintf(soundFileIdStr, sizeof(soundFileIdStr), "%d", soundFileId);
    const char *insertUserParams[3] = { guid, soundFileIdStr, alias };

    res = PQexecParams(g_db.conn,
        "INSERT INTO user_sounds (guid, sound_file_id, alias, visibility) "
        "VALUES ($1, $2, $3, 'private')",
        3, NULL, insertUserParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* Commit transaction */
    res = PQexec(g_db.conn, "COMMIT");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_AddSound: Added sound '%s' for GUID %s (file_id=%d)\n",
           alias, guid, soundFileId);
    return true;
}

bool DB_GetSoundByAlias(const char *guid, const char *alias, DBUserSound *outSound) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[2] = { guid, alias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT us.id, us.guid, us.sound_file_id, us.alias, us.visibility, "
        "us.created_at, us.updated_at, sf.file_path, sf.file_size, sf.duration_seconds "
        "FROM user_sounds us "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE us.guid = $1 AND us.alias = $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found");
        return false;
    }

    outSound->id = getIntField(res, 0, 0);
    safeStrCopy(outSound->guid, getField(res, 0, 1), sizeof(outSound->guid));
    outSound->soundFileId = getIntField(res, 0, 2);
    safeStrCopy(outSound->alias, getField(res, 0, 3), sizeof(outSound->alias));
    safeStrCopy(outSound->visibility, getField(res, 0, 4), sizeof(outSound->visibility));
    outSound->createdAt = parseTimestamp(getField(res, 0, 5));
    outSound->updatedAt = parseTimestamp(getField(res, 0, 6));
    safeStrCopy(outSound->filePath, getField(res, 0, 7), sizeof(outSound->filePath));
    outSound->fileSize = getIntField(res, 0, 8);
    outSound->durationSeconds = getIntField(res, 0, 9);

    PQclear(res);
    return true;
}

int DB_ListSounds(const char *guid, DBSoundListResult *outResult) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    memset(outResult, 0, sizeof(*outResult));

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT us.id, us.guid, us.sound_file_id, us.alias, us.visibility, "
        "us.created_at, us.updated_at, sf.file_path, sf.file_size, sf.duration_seconds "
        "FROM user_sounds us "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE us.guid = $1 "
        "ORDER BY us.alias ASC "
        "LIMIT 100",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    if (count > DB_MAX_SOUNDS_PER_QUERY) {
        count = DB_MAX_SOUNDS_PER_QUERY;
    }

    for (int i = 0; i < count; i++) {
        DBUserSound *s = &outResult->sounds[i];
        s->id = getIntField(res, i, 0);
        safeStrCopy(s->guid, getField(res, i, 1), sizeof(s->guid));
        s->soundFileId = getIntField(res, i, 2);
        safeStrCopy(s->alias, getField(res, i, 3), sizeof(s->alias));
        safeStrCopy(s->visibility, getField(res, i, 4), sizeof(s->visibility));
        s->createdAt = parseTimestamp(getField(res, i, 5));
        s->updatedAt = parseTimestamp(getField(res, i, 6));
        safeStrCopy(s->filePath, getField(res, i, 7), sizeof(s->filePath));
        s->fileSize = getIntField(res, i, 8);
        s->durationSeconds = getIntField(res, i, 9);
    }

    outResult->count = count;
    outResult->totalCount = count;  /* TODO: Get actual total with COUNT query */

    PQclear(res);
    return count;
}

int DB_GetSoundCount(const char *guid) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT COUNT(*) FROM user_sounds WHERE guid = $1",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = getIntField(res, 0, 0);
    PQclear(res);
    return count;
}

bool DB_DeleteSound(const char *guid, const char *alias, char *outFilePath) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    if (outFilePath) {
        outFilePath[0] = '\0';
    }

    /* Get user_sound and sound_file info */
    const char *params[2] = { guid, alias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT us.id, us.sound_file_id, us.visibility, sf.reference_count, sf.file_path "
        "FROM user_sounds us "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE us.guid = $1 AND us.alias = $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found");
        return false;
    }

    int userSoundId = getIntField(res, 0, 0);
    int soundFileId = getIntField(res, 0, 1);
    const char *visibility = getField(res, 0, 2);
    int refCount = getIntField(res, 0, 3);
    const char *filePath = getField(res, 0, 4);

    /* Determine if file should be deleted */
    bool shouldDeleteFile = (strcmp(visibility, "private") == 0 && refCount == 1);

    if (shouldDeleteFile && outFilePath) {
        strncpy(outFilePath, filePath, 512);
    }

    PQclear(res);

    /* Transaction for delete operations */
    res = PQexec(g_db.conn, "BEGIN");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    /* Delete user_sounds entry */
    char userSoundIdStr[16];
    snprintf(userSoundIdStr, sizeof(userSoundIdStr), "%d", userSoundId);
    const char *deleteParams[1] = { userSoundIdStr };

    res = PQexecParams(g_db.conn,
        "DELETE FROM user_sounds WHERE id = $1",
        1, NULL, deleteParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* Decrement reference count */
    char soundFileIdStr[16];
    snprintf(soundFileIdStr, sizeof(soundFileIdStr), "%d", soundFileId);
    const char *updateParams[1] = { soundFileIdStr };

    res = PQexecParams(g_db.conn,
        "UPDATE sound_files SET reference_count = reference_count - 1 WHERE id = $1",
        1, NULL, updateParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* Delete sound_files entry if file should be deleted */
    if (shouldDeleteFile) {
        res = PQexecParams(g_db.conn,
            "DELETE FROM sound_files WHERE id = $1",
            1, NULL, updateParams, NULL, NULL, 0);

        if (!checkResult(res, PGRES_COMMAND_OK)) {
            PQexec(g_db.conn, "ROLLBACK");
            return false;
        }
        PQclear(res);
    }

    /* Commit */
    res = PQexec(g_db.conn, "COMMIT");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_DeleteSound: Deleted '%s' for GUID %s%s\n",
           alias, guid, shouldDeleteFile ? " (file will be removed)" : "");
    return true;
}

bool DB_RenameSound(const char *guid, const char *oldAlias, const char *newAlias) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Check if new alias already exists */
    const char *checkParams[2] = { guid, newAlias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT id FROM user_sounds WHERE guid = $1 AND alias = $2",
        2, NULL, checkParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) > 0) {
        PQclear(res);
        setError("A sound with that name already exists");
        return false;
    }
    PQclear(res);

    /* Update alias */
    const char *updateParams[3] = { newAlias, guid, oldAlias };
    res = PQexecParams(g_db.conn,
        "UPDATE user_sounds SET alias = $1, updated_at = NOW() "
        "WHERE guid = $2 AND alias = $3",
        3, NULL, updateParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }

    int affected = atoi(PQcmdTuples(res));
    PQclear(res);

    if (affected == 0) {
        setError("Sound not found");
        return false;
    }

    printf("DB_RenameSound: Renamed '%s' to '%s' for GUID %s\n", oldAlias, newAlias, guid);
    return true;
}

bool DB_SetVisibility(const char *guid, const char *alias, const char *visibility) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Validate visibility value */
    if (strcmp(visibility, "private") != 0 &&
        strcmp(visibility, "shared") != 0 &&
        strcmp(visibility, "public") != 0) {
        setError("Invalid visibility. Use: private, shared, or public");
        return false;
    }

    /* Get the sound_file_id for this user_sound */
    const char *getParams[2] = { guid, alias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT sound_file_id FROM user_sounds WHERE guid = $1 AND alias = $2",
        2, NULL, getParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found");
        return false;
    }

    int soundFileId = getIntField(res, 0, 0);
    PQclear(res);

    /* Transaction for updating both tables */
    res = PQexec(g_db.conn, "BEGIN");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    /* Update user_sounds visibility */
    const char *updateParams[3] = { visibility, guid, alias };
    res = PQexecParams(g_db.conn,
        "UPDATE user_sounds SET visibility = $1, updated_at = NOW() "
        "WHERE guid = $2 AND alias = $3",
        3, NULL, updateParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* If making public, update sound_files.is_public */
    if (strcmp(visibility, "public") == 0) {
        char soundFileIdStr[16];
        snprintf(soundFileIdStr, sizeof(soundFileIdStr), "%d", soundFileId);
        const char *publicParams[1] = { soundFileIdStr };

        res = PQexecParams(g_db.conn,
            "UPDATE sound_files SET is_public = true WHERE id = $1",
            1, NULL, publicParams, NULL, NULL, 0);

        if (!checkResult(res, PGRES_COMMAND_OK)) {
            PQexec(g_db.conn, "ROLLBACK");
            return false;
        }
        PQclear(res);
    }

    /* Commit */
    res = PQexec(g_db.conn, "COMMIT");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_SetVisibility: Set '%s' to %s for GUID %s\n", alias, visibility, guid);
    return true;
}


/*
 * Public library operations
 */

int DB_ListPublicSounds(DBSoundListResult *outResult, int limit, int offset) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    memset(outResult, 0, sizeof(*outResult));

    char limitStr[16], offsetStr[16];
    snprintf(limitStr, sizeof(limitStr), "%d", limit > 0 ? limit : 50);
    snprintf(offsetStr, sizeof(offsetStr), "%d", offset > 0 ? offset : 0);

    const char *params[2] = { limitStr, offsetStr };
    /* Query sound_files directly to avoid duplicates when multiple users have the same sound */
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT sf.id, sf.added_by_guid, sf.id, sf.original_name, 'public', "
        "sf.created_at, sf.created_at, sf.file_path, sf.file_size, sf.duration_seconds "
        "FROM sound_files sf "
        "WHERE sf.is_public = true "
        "ORDER BY sf.original_name ASC "
        "LIMIT $1 OFFSET $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    if (count > DB_MAX_SOUNDS_PER_QUERY) {
        count = DB_MAX_SOUNDS_PER_QUERY;
    }

    for (int i = 0; i < count; i++) {
        DBUserSound *s = &outResult->sounds[i];
        s->id = getIntField(res, i, 0);
        safeStrCopy(s->guid, getField(res, i, 1), sizeof(s->guid));
        s->soundFileId = getIntField(res, i, 2);
        safeStrCopy(s->alias, getField(res, i, 3), sizeof(s->alias));
        safeStrCopy(s->visibility, getField(res, i, 4), sizeof(s->visibility));
        s->createdAt = parseTimestamp(getField(res, i, 5));
        s->updatedAt = parseTimestamp(getField(res, i, 6));
        safeStrCopy(s->filePath, getField(res, i, 7), sizeof(s->filePath));
        s->fileSize = getIntField(res, i, 8);
        s->durationSeconds = getIntField(res, i, 9);
    }

    outResult->count = count;
    PQclear(res);
    return count;
}

bool DB_GetPublicSoundByName(const char *name, char *outFilePath, int outLen) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Try exact match first, then with .mp3 suffix */
    char nameWithExt[128];
    snprintf(nameWithExt, sizeof(nameWithExt), "%s.mp3", name);

    const char *params[2] = { name, nameWithExt };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT file_path FROM sound_files "
        "WHERE is_public = true AND (original_name = $1 OR original_name = $2) "
        "LIMIT 1",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Public sound not found");
        return false;
    }

    safeStrCopy(outFilePath, getField(res, 0, 0), outLen);
    PQclear(res);
    return true;
}

bool DB_FindSoundByAlias(const char *guid, const char *alias, char *outFilePath, int outLen) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[2] = { guid, alias };

    /*
     * Search order:
     * 1. User's direct sounds (user_sounds table) - exact alias match
     * 2. User's playlist sounds (sounds in playlists owned by user) - alias match
     *
     * Use UNION to combine both sources and return first match.
     */
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT file_path FROM ("
        "  SELECT sf.file_path, 1 as priority "
        "  FROM user_sounds us "
        "  JOIN sound_files sf ON sf.id = us.sound_file_id "
        "  WHERE us.guid = $1 AND us.alias = $2 "
        "  UNION ALL "
        "  SELECT sf.file_path, 2 as priority "
        "  FROM sound_playlist_items pi "
        "  JOIN sound_playlists p ON p.id = pi.playlist_id "
        "  JOIN user_sounds us ON us.id = pi.user_sound_id "
        "  JOIN sound_files sf ON sf.id = us.sound_file_id "
        "  WHERE p.guid = $1 AND us.alias = $2 "
        ") sub "
        "ORDER BY priority ASC "
        "LIMIT 1",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found in local library or playlists");
        return false;
    }

    safeStrCopy(outFilePath, getField(res, 0, 0), outLen);
    PQclear(res);
    printf("DB_FindSoundByAlias: Found '%s' for GUID %s\n", alias, guid);
    return true;
}

bool DB_FindPublicSoundByAlias(const char *alias, char *outFilePath, int outLen) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[1] = { alias };

    /*
     * Search order:
     * 1. Public sounds - match by original_name (without .mp3) or any public user alias
     * 2. Public playlist sounds - sounds in public playlists matching alias
     *
     * Use UNION to combine both sources and return first match.
     */
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT file_path FROM ("
        "  SELECT sf.file_path, 1 as priority "
        "  FROM sound_files sf "
        "  WHERE sf.is_public = true "
        "    AND (sf.original_name = $1 OR sf.original_name = $1 || '.mp3') "
        "  UNION ALL "
        "  SELECT sf.file_path, 2 as priority "
        "  FROM user_sounds us "
        "  JOIN sound_files sf ON sf.id = us.sound_file_id "
        "  WHERE us.visibility = 'public' AND us.alias = $1 "
        "  UNION ALL "
        "  SELECT sf.file_path, 3 as priority "
        "  FROM sound_playlist_items pi "
        "  JOIN sound_playlists p ON p.id = pi.playlist_id "
        "  JOIN user_sounds us ON us.id = pi.user_sound_id "
        "  JOIN sound_files sf ON sf.id = us.sound_file_id "
        "  WHERE p.is_public = true AND us.alias = $1 "
        ") sub "
        "ORDER BY priority ASC "
        "LIMIT 1",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found in public library or playlists");
        return false;
    }

    safeStrCopy(outFilePath, getField(res, 0, 0), outLen);
    PQclear(res);
    printf("DB_FindPublicSoundByAlias: Found public sound '%s'\n", alias);
    return true;
}

bool DB_AddFromPublic(const char *guid, int soundFileId, const char *alias) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Transaction */
    PGresult *res = PQexec(g_db.conn, "BEGIN");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    /* Insert user_sounds entry */
    char soundFileIdStr[16];
    snprintf(soundFileIdStr, sizeof(soundFileIdStr), "%d", soundFileId);
    const char *insertParams[3] = { guid, soundFileIdStr, alias };

    res = PQexecParams(g_db.conn,
        "INSERT INTO user_sounds (guid, sound_file_id, alias, visibility) "
        "VALUES ($1, $2, $3, 'private')",
        3, NULL, insertParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* Increment reference count */
    const char *updateParams[1] = { soundFileIdStr };
    res = PQexecParams(g_db.conn,
        "UPDATE sound_files SET reference_count = reference_count + 1 WHERE id = $1",
        1, NULL, updateParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* Commit */
    res = PQexec(g_db.conn, "COMMIT");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_AddFromPublic: Added file_id=%d as '%s' for GUID %s\n",
           soundFileId, alias, guid);
    return true;
}


/*
 * Playlist operations
 */

bool DB_CreatePlaylist(const char *guid, const char *name,
                       const char *description, int *outPlaylistId) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[3] = { guid, name, description ? description : "" };
    PGresult *res = PQexecParams(g_db.conn,
        "INSERT INTO sound_playlists (guid, name, description, is_public, current_position) "
        "VALUES ($1, $2, $3, false, 1) RETURNING id",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (outPlaylistId) {
        *outPlaylistId = getIntField(res, 0, 0);
    }

    PQclear(res);
    printf("DB_CreatePlaylist: Created '%s' for GUID %s\n", name, guid);
    return true;
}

bool DB_DeletePlaylist(const char *guid, const char *name) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[2] = { guid, name };
    PGresult *res = PQexecParams(g_db.conn,
        "DELETE FROM sound_playlists WHERE guid = $1 AND name = $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }

    int affected = atoi(PQcmdTuples(res));
    PQclear(res);

    if (affected == 0) {
        setError("Playlist not found");
        return false;
    }

    printf("DB_DeletePlaylist: Deleted '%s' for GUID %s\n", name, guid);
    return true;
}

int DB_ListPlaylists(const char *guid, DBPlaylistListResult *outResult) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    memset(outResult, 0, sizeof(*outResult));

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT p.id, p.guid, p.name, p.description, p.is_public, "
        "p.current_position, p.created_at, p.updated_at, "
        "COALESCE((SELECT COUNT(*) FROM sound_playlist_items WHERE playlist_id = p.id), 0) as sound_count "
        "FROM sound_playlists p "
        "WHERE p.guid = $1 "
        "ORDER BY p.name ASC",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    if (count > DB_MAX_PLAYLISTS_PER_QUERY) {
        count = DB_MAX_PLAYLISTS_PER_QUERY;
    }

    for (int i = 0; i < count; i++) {
        DBPlaylist *p = &outResult->playlists[i];
        p->id = getIntField(res, i, 0);
        safeStrCopy(p->guid, getField(res, i, 1), sizeof(p->guid));
        safeStrCopy(p->name, getField(res, i, 2), sizeof(p->name));
        safeStrCopy(p->description, getField(res, i, 3), sizeof(p->description));
        p->isPublic = getBoolField(res, i, 4);
        p->currentPosition = getIntField(res, i, 5);
        p->createdAt = parseTimestamp(getField(res, i, 6));
        p->updatedAt = parseTimestamp(getField(res, i, 7));
        p->soundCount = getIntField(res, i, 8);
    }

    outResult->count = count;
    PQclear(res);
    return count;
}

int DB_GetPlaylistSounds(const char *guid, const char *playlistName,
                         DBPlaylistItemsResult *outResult) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    memset(outResult, 0, sizeof(*outResult));

    const char *params[2] = { guid, playlistName };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT pi.id, pi.playlist_id, pi.user_sound_id, pi.order_number, pi.added_at, "
        "us.alias, sf.file_path, sf.duration_seconds "
        "FROM sound_playlist_items pi "
        "JOIN sound_playlists p ON p.id = pi.playlist_id "
        "JOIN user_sounds us ON us.id = pi.user_sound_id "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE p.guid = $1 AND p.name = $2 "
        "ORDER BY pi.order_number ASC",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    if (count > DB_MAX_SOUNDS_PER_QUERY) {
        count = DB_MAX_SOUNDS_PER_QUERY;
    }

    for (int i = 0; i < count; i++) {
        DBPlaylistItem *item = &outResult->items[i];
        item->id = getIntField(res, i, 0);
        item->playlistId = getIntField(res, i, 1);
        item->userSoundId = getIntField(res, i, 2);
        item->orderNumber = getIntField(res, i, 3);
        item->addedAt = parseTimestamp(getField(res, i, 4));
        safeStrCopy(item->alias, getField(res, i, 5), sizeof(item->alias));
        safeStrCopy(item->filePath, getField(res, i, 6), sizeof(item->filePath));
        item->durationSeconds = getIntField(res, i, 7);
    }

    outResult->count = count;
    PQclear(res);
    return count;
}

bool DB_AddToPlaylist(const char *guid, const char *playlistName,
                      const char *soundAlias) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Get playlist ID and user_sound ID */
    const char *params[3] = { guid, playlistName, soundAlias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT p.id, us.id, "
        "COALESCE((SELECT MAX(order_number) FROM sound_playlist_items WHERE playlist_id = p.id), 0) + 1 "
        "FROM sound_playlists p, user_sounds us "
        "WHERE p.guid = $1 AND p.name = $2 AND us.guid = $1 AND us.alias = $3",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Playlist or sound not found");
        return false;
    }

    int playlistId = getIntField(res, 0, 0);
    int userSoundId = getIntField(res, 0, 1);
    int orderNumber = getIntField(res, 0, 2);
    PQclear(res);

    /* Insert playlist item */
    char playlistIdStr[16], userSoundIdStr[16], orderStr[16];
    snprintf(playlistIdStr, sizeof(playlistIdStr), "%d", playlistId);
    snprintf(userSoundIdStr, sizeof(userSoundIdStr), "%d", userSoundId);
    snprintf(orderStr, sizeof(orderStr), "%d", orderNumber);

    const char *insertParams[3] = { playlistIdStr, userSoundIdStr, orderStr };
    res = PQexecParams(g_db.conn,
        "INSERT INTO sound_playlist_items (playlist_id, user_sound_id, order_number) "
        "VALUES ($1, $2, $3)",
        3, NULL, insertParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_AddToPlaylist: Added '%s' to playlist '%s' at position %d\n",
           soundAlias, playlistName, orderNumber);
    return true;
}

bool DB_RemoveFromPlaylist(const char *guid, const char *playlistName,
                           const char *soundAlias) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[3] = { guid, playlistName, soundAlias };
    PGresult *res = PQexecParams(g_db.conn,
        "DELETE FROM sound_playlist_items pi "
        "USING sound_playlists p, user_sounds us "
        "WHERE pi.playlist_id = p.id AND pi.user_sound_id = us.id "
        "AND p.guid = $1 AND p.name = $2 AND us.alias = $3",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }

    int affected = atoi(PQcmdTuples(res));
    PQclear(res);

    if (affected == 0) {
        setError("Sound not in playlist");
        return false;
    }

    printf("DB_RemoveFromPlaylist: Removed '%s' from playlist '%s'\n",
           soundAlias, playlistName);
    return true;
}

bool DB_ReorderPlaylist(const char *guid, const char *playlistName,
                        const char **soundAliases, int count) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Get playlist ID */
    const char *params[2] = { guid, playlistName };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT id FROM sound_playlists WHERE guid = $1 AND name = $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Playlist not found");
        return false;
    }

    int playlistId = getIntField(res, 0, 0);
    PQclear(res);

    /* Transaction for reorder */
    res = PQexec(g_db.conn, "BEGIN");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    /* Update order for each sound */
    for (int i = 0; i < count; i++) {
        char playlistIdStr[16], orderStr[16];
        snprintf(playlistIdStr, sizeof(playlistIdStr), "%d", playlistId);
        snprintf(orderStr, sizeof(orderStr), "%d", i + 1);

        const char *updateParams[4] = { orderStr, playlistIdStr, guid, soundAliases[i] };
        res = PQexecParams(g_db.conn,
            "UPDATE sound_playlist_items pi "
            "SET order_number = $1 "
            "FROM user_sounds us "
            "WHERE pi.user_sound_id = us.id AND pi.playlist_id = $2 "
            "AND us.guid = $3 AND us.alias = $4",
            4, NULL, updateParams, NULL, NULL, 0);

        if (!checkResult(res, PGRES_COMMAND_OK)) {
            PQexec(g_db.conn, "ROLLBACK");
            return false;
        }
        PQclear(res);
    }

    /* Commit */
    res = PQexec(g_db.conn, "COMMIT");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_ReorderPlaylist: Reordered %d items in playlist '%s'\n", count, playlistName);
    return true;
}

int DB_GetPlaylistPosition(const char *guid, const char *playlistName) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    const char *params[2] = { guid, playlistName };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT current_position FROM sound_playlists WHERE guid = $1 AND name = $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Playlist not found");
        return -1;
    }

    int position = getIntField(res, 0, 0);
    PQclear(res);
    return position;
}

bool DB_SetPlaylistPosition(const char *guid, const char *playlistName, int position) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    char positionStr[16];
    snprintf(positionStr, sizeof(positionStr), "%d", position);

    const char *params[3] = { positionStr, guid, playlistName };
    PGresult *res = PQexecParams(g_db.conn,
        "UPDATE sound_playlists SET current_position = $1, updated_at = NOW() "
        "WHERE guid = $2 AND name = $3",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }

    int affected = atoi(PQcmdTuples(res));
    PQclear(res);

    return affected > 0;
}

bool DB_GetPlaylistSoundAtPosition(const char *guid, const char *playlistName,
                                   int position, DBPlaylistItem *outItem) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* If position is 0, get current position */
    int targetPosition = position;
    if (targetPosition <= 0) {
        targetPosition = DB_GetPlaylistPosition(guid, playlistName);
        if (targetPosition < 1) targetPosition = 1;
    }

    char positionStr[16];
    snprintf(positionStr, sizeof(positionStr), "%d", targetPosition);

    const char *params[3] = { guid, playlistName, positionStr };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT pi.id, pi.playlist_id, pi.user_sound_id, pi.order_number, pi.added_at, "
        "us.alias, sf.file_path, sf.duration_seconds "
        "FROM sound_playlist_items pi "
        "JOIN sound_playlists p ON p.id = pi.playlist_id "
        "JOIN user_sounds us ON us.id = pi.user_sound_id "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE p.guid = $1 AND p.name = $2 AND pi.order_number = $3",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found at that position");
        return false;
    }

    outItem->id = getIntField(res, 0, 0);
    outItem->playlistId = getIntField(res, 0, 1);
    outItem->userSoundId = getIntField(res, 0, 2);
    outItem->orderNumber = getIntField(res, 0, 3);
    outItem->addedAt = parseTimestamp(getField(res, 0, 4));
    safeStrCopy(outItem->alias, getField(res, 0, 5), sizeof(outItem->alias));
    safeStrCopy(outItem->filePath, getField(res, 0, 6), sizeof(outItem->filePath));
    outItem->durationSeconds = getIntField(res, 0, 7);

    PQclear(res);
    return true;
}

int DB_ListPublicPlaylists(DBPlaylistListResult *outResult) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    memset(outResult, 0, sizeof(*outResult));

    PGresult *res = PQexec(g_db.conn,
        "SELECT p.id, p.guid, p.name, p.description, p.is_public, "
        "p.current_position, p.created_at, p.updated_at, "
        "COALESCE((SELECT COUNT(*) FROM sound_playlist_items WHERE playlist_id = p.id), 0) as sound_count "
        "FROM sound_playlists p "
        "WHERE p.is_public = true "
        "ORDER BY p.name ASC");

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    if (count > DB_MAX_PLAYLISTS_PER_QUERY) {
        count = DB_MAX_PLAYLISTS_PER_QUERY;
    }

    for (int i = 0; i < count; i++) {
        DBPlaylist *p = &outResult->playlists[i];
        p->id = getIntField(res, i, 0);
        safeStrCopy(p->guid, getField(res, i, 1), sizeof(p->guid));
        safeStrCopy(p->name, getField(res, i, 2), sizeof(p->name));
        safeStrCopy(p->description, getField(res, i, 3), sizeof(p->description));
        p->isPublic = getBoolField(res, i, 4);
        p->currentPosition = getIntField(res, i, 5);
        p->createdAt = parseTimestamp(getField(res, i, 6));
        p->updatedAt = parseTimestamp(getField(res, i, 7));
        p->soundCount = getIntField(res, i, 8);
    }

    outResult->count = count;
    PQclear(res);
    return count;
}

int DB_GetPublicPlaylistSounds(const char *playlistName, DBPlaylistItemsResult *outResult) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    memset(outResult, 0, sizeof(*outResult));

    const char *params[1] = { playlistName };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT pi.id, pi.playlist_id, pi.user_sound_id, pi.order_number, pi.added_at, "
        "us.alias, sf.file_path, sf.duration_seconds "
        "FROM sound_playlist_items pi "
        "JOIN sound_playlists p ON p.id = pi.playlist_id "
        "JOIN user_sounds us ON us.id = pi.user_sound_id "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE p.is_public = true AND p.name = $1 "
        "ORDER BY pi.order_number ASC",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    if (count > DB_MAX_SOUNDS_PER_QUERY) {
        count = DB_MAX_SOUNDS_PER_QUERY;
    }

    for (int i = 0; i < count; i++) {
        DBPlaylistItem *item = &outResult->items[i];
        item->id = getIntField(res, i, 0);
        item->playlistId = getIntField(res, i, 1);
        item->userSoundId = getIntField(res, i, 2);
        item->orderNumber = getIntField(res, i, 3);
        item->addedAt = parseTimestamp(getField(res, i, 4));
        safeStrCopy(item->alias, getField(res, i, 5), sizeof(item->alias));
        safeStrCopy(item->filePath, getField(res, i, 6), sizeof(item->filePath));
        item->durationSeconds = getIntField(res, i, 7);
    }

    outResult->count = count;
    PQclear(res);
    return count;
}

bool DB_GetPublicPlaylistSoundAtPosition(const char *playlistName, int position,
                                         DBPlaylistItem *outItem) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    char positionStr[16];
    snprintf(positionStr, sizeof(positionStr), "%d", position);

    const char *params[2] = { playlistName, positionStr };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT pi.id, pi.playlist_id, pi.user_sound_id, pi.order_number, pi.added_at, "
        "us.alias, sf.file_path, sf.duration_seconds "
        "FROM sound_playlist_items pi "
        "JOIN sound_playlists p ON p.id = pi.playlist_id "
        "JOIN user_sounds us ON us.id = pi.user_sound_id "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE p.is_public = true AND p.name = $1 AND pi.order_number = $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found at that position in public playlist");
        return false;
    }

    outItem->id = getIntField(res, 0, 0);
    outItem->playlistId = getIntField(res, 0, 1);
    outItem->userSoundId = getIntField(res, 0, 2);
    outItem->orderNumber = getIntField(res, 0, 3);
    outItem->addedAt = parseTimestamp(getField(res, 0, 4));
    safeStrCopy(outItem->alias, getField(res, 0, 5), sizeof(outItem->alias));
    safeStrCopy(outItem->filePath, getField(res, 0, 6), sizeof(outItem->filePath));
    outItem->durationSeconds = getIntField(res, 0, 7);

    PQclear(res);
    return true;
}

bool DB_SetPlaylistVisibility(const char *guid, const char *playlistName, bool isPublic) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[3] = { isPublic ? "true" : "false", guid, playlistName };
    PGresult *res = PQexecParams(g_db.conn,
        "UPDATE sound_playlists SET is_public = $1, updated_at = NOW() "
        "WHERE guid = $2 AND name = $3",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }

    int affected = atoi(PQcmdTuples(res));
    PQclear(res);

    if (affected == 0) {
        setError("Playlist not found");
        return false;
    }

    return true;
}


/*
 * List user sounds from database (includes shared sounds)
 */
int DB_ListUserSounds(const char *guid, SoundInfo *outList, int maxCount) {
    if (!DB_IsConnected()) {
        return -1;
    }

    char maxStr[16];
    snprintf(maxStr, sizeof(maxStr), "%d", maxCount);

    const char *params[2] = { guid, maxStr };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT us.alias, sf.file_size, sf.file_path "
        "FROM user_sounds us "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE us.guid = $1 "
        "ORDER BY us.alias "
        "LIMIT $2",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    for (int i = 0; i < count && i < maxCount; i++) {
        safeStrCopy(outList[i].name, getField(res, i, 0), sizeof(outList[i].name));
        outList[i].fileSize = getIntField(res, i, 1);
        outList[i].addedTime = 0;  /* Not tracking in this query */
    }

    PQclear(res);
    return count;
}


/*
 * Share operations
 */

bool DB_CreateShare(const char *fromGuid, const char *toGuid,
                    const char *soundAlias, const char *suggestedAlias,
                    const char *fromPlayerName) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Get sound_file_id for the sound */
    const char *getParams[2] = { fromGuid, soundAlias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT sound_file_id FROM user_sounds WHERE guid = $1 AND alias = $2",
        2, NULL, getParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Sound not found");
        return false;
    }

    int soundFileId = getIntField(res, 0, 0);
    PQclear(res);

    /* Insert share request */
    char soundFileIdStr[16];
    snprintf(soundFileIdStr, sizeof(soundFileIdStr), "%d", soundFileId);

    const char *insertParams[5] = { soundFileIdStr, fromGuid, toGuid,
                                    suggestedAlias ? suggestedAlias : soundAlias,
                                    fromPlayerName ? fromPlayerName : "" };
    res = PQexecParams(g_db.conn,
        "INSERT INTO sound_shares (sound_file_id, from_guid, to_guid, suggested_alias, from_player_name, status) "
        "VALUES ($1, $2, $3, $4, $5, 'pending') "
        "ON CONFLICT (sound_file_id, from_guid, to_guid) DO UPDATE SET "
        "status = 'pending', suggested_alias = $4, from_player_name = $5, "
        "created_at = NOW(), responded_at = NULL",
        5, NULL, insertParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_CreateShare: %s (%s) shared '%s' with %s\n",
           fromPlayerName ? fromPlayerName : fromGuid, fromGuid, soundAlias, toGuid);
    return true;
}

int DB_ListPendingShares(const char *toGuid, DBShareListResult *outResult) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return -1;
    }

    memset(outResult, 0, sizeof(*outResult));

    const char *params[1] = { toGuid };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT ss.id, ss.sound_file_id, ss.from_guid, ss.to_guid, ss.suggested_alias, "
        "ss.status, ss.created_at, ss.responded_at, sf.original_name, sf.file_size, "
        "COALESCE(ss.from_player_name, ss.from_guid) as from_player_name "
        "FROM sound_shares ss "
        "JOIN sound_files sf ON sf.id = ss.sound_file_id "
        "WHERE ss.to_guid = $1 AND ss.status = 'pending' "
        "ORDER BY ss.created_at DESC",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return -1;
    }

    int count = PQntuples(res);
    if (count > DB_MAX_SHARES_PER_QUERY) {
        count = DB_MAX_SHARES_PER_QUERY;
    }

    for (int i = 0; i < count; i++) {
        DBShareRequest *s = &outResult->shares[i];
        s->id = getIntField(res, i, 0);
        s->soundFileId = getIntField(res, i, 1);
        safeStrCopy(s->fromGuid, getField(res, i, 2), sizeof(s->fromGuid));
        safeStrCopy(s->toGuid, getField(res, i, 3), sizeof(s->toGuid));
        safeStrCopy(s->suggestedAlias, getField(res, i, 4), sizeof(s->suggestedAlias));
        safeStrCopy(s->status, getField(res, i, 5), sizeof(s->status));
        s->createdAt = parseTimestamp(getField(res, i, 6));
        s->respondedAt = parseTimestamp(getField(res, i, 7));
        safeStrCopy(s->originalName, getField(res, i, 8), sizeof(s->originalName));
        s->fileSize = getIntField(res, i, 9);
        safeStrCopy(s->fromPlayerName, getField(res, i, 10), sizeof(s->fromPlayerName));
    }

    outResult->count = count;
    PQclear(res);
    return count;
}

bool DB_AcceptShare(const char *toGuid, const char *fromGuid,
                    int soundFileId, const char *alias) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Transaction */
    PGresult *res = PQexec(g_db.conn, "BEGIN");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    /* Update share status */
    char soundFileIdStr[16];
    snprintf(soundFileIdStr, sizeof(soundFileIdStr), "%d", soundFileId);

    const char *updateParams[3] = { toGuid, fromGuid, soundFileIdStr };
    res = PQexecParams(g_db.conn,
        "UPDATE sound_shares SET status = 'accepted', responded_at = NOW() "
        "WHERE to_guid = $1 AND from_guid = $2 AND sound_file_id = $3 AND status = 'pending'",
        3, NULL, updateParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }

    int affected = atoi(PQcmdTuples(res));
    PQclear(res);

    if (affected == 0) {
        PQexec(g_db.conn, "ROLLBACK");
        setError("Share request not found");
        return false;
    }

    /* Add to user's library */
    const char *insertParams[3] = { toGuid, soundFileIdStr, alias };
    res = PQexecParams(g_db.conn,
        "INSERT INTO user_sounds (guid, sound_file_id, alias, visibility) "
        "VALUES ($1, $2, $3, 'private') "
        "ON CONFLICT (guid, sound_file_id) DO NOTHING",
        3, NULL, insertParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* Increment reference count */
    const char *incParams[1] = { soundFileIdStr };
    res = PQexecParams(g_db.conn,
        "UPDATE sound_files SET reference_count = reference_count + 1 WHERE id = $1",
        1, NULL, incParams, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        PQexec(g_db.conn, "ROLLBACK");
        return false;
    }
    PQclear(res);

    /* Commit */
    res = PQexec(g_db.conn, "COMMIT");
    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    printf("DB_AcceptShare: %s accepted share from %s (file_id=%d)\n",
           toGuid, fromGuid, soundFileId);
    return true;
}

bool DB_RejectShare(const char *toGuid, const char *fromGuid, int soundFileId) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    char soundFileIdStr[16];
    snprintf(soundFileIdStr, sizeof(soundFileIdStr), "%d", soundFileId);

    const char *params[3] = { toGuid, fromGuid, soundFileIdStr };
    PGresult *res = PQexecParams(g_db.conn,
        "UPDATE sound_shares SET status = 'rejected', responded_at = NOW() "
        "WHERE to_guid = $1 AND from_guid = $2 AND sound_file_id = $3 AND status = 'pending'",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }

    int affected = atoi(PQcmdTuples(res));
    PQclear(res);

    if (affected == 0) {
        setError("Share request not found");
        return false;
    }

    printf("DB_RejectShare: %s rejected share from %s\n", toGuid, fromGuid);
    return true;
}


/*
 * Registration/verification operations
 */

bool DB_CreateVerificationCode(const char *guid, const char *playerName,
                               char *outCode) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Generate random 6-digit numeric code (easy to remember) */
    char code[7];
    srand((unsigned int)time(NULL) ^ (unsigned int)(size_t)guid);
    for (int i = 0; i < 6; i++) {
        code[i] = '0' + (rand() % 10);
    }
    code[6] = '\0';

    /* Insert or update (upsert) */
    const char *params[3] = { guid, code, playerName };
    PGresult *res = PQexecParams(g_db.conn,
        "INSERT INTO verification_codes (guid, code, player_name, expires_at) "
        "VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes') "
        "ON CONFLICT (guid) DO UPDATE SET code = $2, player_name = $3, "
        "expires_at = NOW() + INTERVAL '10 minutes', used = false, created_at = NOW()",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    strncpy(outCode, code, 7);
    printf("DB_CreateVerificationCode: Generated code %s for GUID %s\n", code, guid);
    return true;
}

bool DB_VerifyCode(const char *code, char *outGuid, char *outPlayerName) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[1] = { code };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT guid, player_name FROM verification_codes "
        "WHERE code = $1 AND expires_at > NOW() AND used = false",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Invalid or expired code");
        return false;
    }

    safeStrCopy(outGuid, getField(res, 0, 0), 33);
    safeStrCopy(outPlayerName, getField(res, 0, 1), 65);
    PQclear(res);

    return true;
}

bool DB_MarkCodeUsed(const char *code) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[1] = { code };
    PGresult *res = PQexecParams(g_db.conn,
        "UPDATE verification_codes SET used = true WHERE code = $1",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_COMMAND_OK)) {
        return false;
    }
    PQclear(res);

    return true;
}


/*
 * Utility functions
 */

void DB_EscapeString(const char *str, char *outEscaped, int outLen) {
    if (!g_db.conn || !str) {
        if (outEscaped && outLen > 0) outEscaped[0] = '\0';
        return;
    }

    char *escaped = PQescapeLiteral(g_db.conn, str, strlen(str));
    if (escaped) {
        strncpy(outEscaped, escaped, outLen - 1);
        outEscaped[outLen - 1] = '\0';
        PQfreemem(escaped);
    } else {
        outEscaped[0] = '\0';
    }
}

bool DB_ExecuteRaw(const char *query) {
    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    PGresult *res = PQexec(g_db.conn, query);
    ExecStatusType status = PQresultStatus(res);

    bool success = (status == PGRES_COMMAND_OK || status == PGRES_TUPLES_OK);
    if (!success) {
        setErrorFromPG();
    }

    PQclear(res);
    return success;
}


/*
 * Dynamic sound menu operations
 */

bool DB_GetUserMenus(const char *guid, DBMenuResult *outResult) {
    if (!outResult) return false;
    memset(outResult, 0, sizeof(*outResult));

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Get menus with items from:
     * 1. Manual sound items (item_type='sound')
     * 2. Playlist-backed menus (menu.playlist_id set)
     * 3. Playlist items within menus (item_type='playlist' in menu_items)
     */
    const char *params[1] = { guid };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT menu_position, menu_name, is_playlist, item_position, item_name, sound_alias FROM ("
        "  /* Manual sound items (item_type='sound') */"
        "  SELECT m.menu_position, m.menu_name, false as is_playlist, "
        "         mi.item_position, COALESCE(mi.display_name, us.alias) as item_name, us.alias as sound_alias "
        "  FROM user_sound_menus m "
        "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
        "  JOIN user_sounds us ON us.id = mi.sound_id "
        "  WHERE m.user_guid = $1 AND mi.item_type = 'sound' "
        "  UNION ALL "
        "  /* Playlist-backed menus (menu.playlist_id set) */"
        "  SELECT m.menu_position, m.menu_name, true as is_playlist, "
        "         pi.order_number as item_position, us.alias as item_name, us.alias as sound_alias "
        "  FROM user_sound_menus m "
        "  JOIN sound_playlists p ON p.id = m.playlist_id "
        "  JOIN sound_playlist_items pi ON pi.playlist_id = p.id "
        "  JOIN user_sounds us ON us.id = pi.user_sound_id "
        "  WHERE m.user_guid = $1 AND m.playlist_id IS NOT NULL "
        "  UNION ALL "
        "  /* Playlist items within menu (item_type='playlist') - expand playlist sounds */"
        "  SELECT m.menu_position, m.menu_name, true as is_playlist, "
        "         pi.order_number as item_position, us.alias as item_name, us.alias as sound_alias "
        "  FROM user_sound_menus m "
        "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
        "  JOIN sound_playlist_items pi ON pi.playlist_id = mi.playlist_id "
        "  JOIN user_sounds us ON us.id = pi.user_sound_id "
        "  WHERE m.user_guid = $1 AND mi.item_type = 'playlist' "
        "  UNION ALL "
        "  /* Menus with no items (empty) */"
        "  SELECT m.menu_position, m.menu_name, false as is_playlist, "
        "         NULL::int as item_position, NULL as item_name, NULL as sound_alias "
        "  FROM user_sound_menus m "
        "  LEFT JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
        "  LEFT JOIN sound_playlist_items pi ON pi.playlist_id = m.playlist_id "
        "  WHERE m.user_guid = $1 AND mi.id IS NULL AND pi.id IS NULL "
        ") combined "
        "ORDER BY menu_position, item_position NULLS LAST",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    int rows = PQntuples(res);
    int currentMenuPos = -1;
    int menuIdx = -1;

    for (int i = 0; i < rows && outResult->count < DB_MAX_MENUS; i++) {
        int menuPos = atoi(PQgetvalue(res, i, 0));

        if (menuPos != currentMenuPos) {
            /* New menu */
            menuIdx = outResult->count++;
            currentMenuPos = menuPos;

            DBMenu *menu = &outResult->menus[menuIdx];
            menu->position = menuPos;
            strncpy(menu->name, PQgetvalue(res, i, 1), sizeof(menu->name) - 1);
            menu->isPlaylist = (PQgetvalue(res, i, 2)[0] == 't');
            menu->itemCount = 0;
        }

        /* Add item if present (LEFT JOIN may have NULL items) */
        if (!PQgetisnull(res, i, 3) && menuIdx >= 0) {
            DBMenu *menu = &outResult->menus[menuIdx];
            if (menu->itemCount < DB_MAX_MENU_ITEMS) {
                DBMenuItem *item = &menu->items[menu->itemCount++];
                item->position = atoi(PQgetvalue(res, i, 3));
                strncpy(item->name, PQgetvalue(res, i, 4), sizeof(item->name) - 1);
                strncpy(item->soundAlias, PQgetvalue(res, i, 5), sizeof(item->soundAlias) - 1);
            }
        }
    }

    PQclear(res);
    return true;
}

bool DB_GetMenuItemSound(const char *guid, int menuPos, int itemPos,
                         char *outFilePath, int outLen) {
    if (outFilePath && outLen > 0) outFilePath[0] = '\0';

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    char menuPosStr[8], itemPosStr[8];
    snprintf(menuPosStr, sizeof(menuPosStr), "%d", menuPos);
    snprintf(itemPosStr, sizeof(itemPosStr), "%d", itemPos);

    const char *params[3] = { guid, menuPosStr, itemPosStr };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT file_path FROM ("
        "  /* Manual sound items (item_type='sound') */"
        "  SELECT sf.file_path, mi.item_position "
        "  FROM user_sound_menu_items mi "
        "  JOIN user_sound_menus m ON m.id = mi.menu_id "
        "  JOIN user_sounds us ON us.id = mi.sound_id "
        "  JOIN sound_files sf ON sf.id = us.sound_file_id "
        "  WHERE m.user_guid = $1 AND m.menu_position = $2 AND mi.item_type = 'sound' "
        "  UNION ALL "
        "  /* Playlist-backed menus (menu.playlist_id set) */"
        "  SELECT sf.file_path, pi.order_number as item_position "
        "  FROM user_sound_menus m "
        "  JOIN sound_playlist_items pi ON pi.playlist_id = m.playlist_id "
        "  JOIN user_sounds us ON us.id = pi.user_sound_id "
        "  JOIN sound_files sf ON sf.id = us.sound_file_id "
        "  WHERE m.user_guid = $1 AND m.menu_position = $2 AND m.playlist_id IS NOT NULL "
        "  UNION ALL "
        "  /* Playlist items within menu (item_type='playlist') */"
        "  SELECT sf.file_path, pi.order_number as item_position "
        "  FROM user_sound_menu_items mi "
        "  JOIN user_sound_menus m ON m.id = mi.menu_id "
        "  JOIN sound_playlist_items pi ON pi.playlist_id = mi.playlist_id "
        "  JOIN user_sounds us ON us.id = pi.user_sound_id "
        "  JOIN sound_files sf ON sf.id = us.sound_file_id "
        "  WHERE m.user_guid = $1 AND m.menu_position = $2 AND mi.item_type = 'playlist' "
        ") combined WHERE item_position = $3",
        3, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0) {
        PQclear(res);
        setError("Menu item not found");
        return false;
    }

    strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
    outFilePath[outLen - 1] = '\0';

    PQclear(res);
    return true;
}

/**
 * Get a page of menu items for hierarchical navigation.
 * menuId=0 means root level menus, otherwise it's a specific menu's items.
 * isServerMenu=true returns server default menus (all players see the same)
 * isServerMenu=false returns player's personal menus
 */
bool DB_GetMenuPage(const char *guid, int menuId, int pageOffset, bool isServerMenu, DBMenuPageResult *outResult) {
    if (!outResult) return false;
    memset(outResult, 0, sizeof(*outResult));
    outResult->found = false;

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    char menuIdStr[16], offsetStr[16], limitStr[8];
    snprintf(menuIdStr, sizeof(menuIdStr), "%d", menuId);
    snprintf(offsetStr, sizeof(offsetStr), "%d", pageOffset);
    snprintf(limitStr, sizeof(limitStr), "%d", DB_MAX_MENU_ITEMS);

    if (menuId == 0) {
        /* Root level: show root items from user_sound_menu_items where menu_id IS NULL
         * Root items can be sounds, playlists, or menus (via nested_menu_id)
         * For server menus: is_server_default = true (no user_guid filter)
         * For personal menus: is_server_default = false AND user_guid = $1
         */
        PGresult *res;
        if (isServerMenu) {
            /* Server root items - all players see the same items */
            const char *params[2] = { limitStr, offsetStr };
            res = PQexecParams(g_db.conn,
                "SELECT "
                "  i.item_position, "
                "  i.item_type, "
                "  COALESCE(i.display_name, us.alias, m.menu_name, p.name) as display_name, "
                "  us.alias as sound_alias, "
                "  i.nested_menu_id, "
                "  i.playlist_id, "
                "  (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id IS NULL AND is_server_default = true) as total_count "
                "FROM user_sound_menu_items i "
                "LEFT JOIN user_sounds us ON i.sound_id = us.id "
                "LEFT JOIN user_sound_menus m ON i.nested_menu_id = m.id "
                "LEFT JOIN sound_playlists p ON i.playlist_id = p.id "
                "WHERE i.menu_id IS NULL AND i.is_server_default = true "
                "ORDER BY i.item_position "
                "LIMIT $1 OFFSET $2",
                2, NULL, params, NULL, NULL, 0);
        } else {
            /* Personal root items - specific to the player */
            const char *params[3] = { guid, limitStr, offsetStr };
            res = PQexecParams(g_db.conn,
                "SELECT "
                "  i.item_position, "
                "  i.item_type, "
                "  COALESCE(i.display_name, us.alias, m.menu_name, p.name) as display_name, "
                "  us.alias as sound_alias, "
                "  i.nested_menu_id, "
                "  i.playlist_id, "
                "  (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id IS NULL AND user_guid = $1 AND (is_server_default = false OR is_server_default IS NULL)) as total_count "
                "FROM user_sound_menu_items i "
                "LEFT JOIN user_sounds us ON i.sound_id = us.id "
                "LEFT JOIN user_sound_menus m ON i.nested_menu_id = m.id "
                "LEFT JOIN sound_playlists p ON i.playlist_id = p.id "
                "WHERE i.menu_id IS NULL AND i.user_guid = $1 AND (i.is_server_default = false OR i.is_server_default IS NULL) "
                "ORDER BY i.item_position "
                "LIMIT $2 OFFSET $3",
                3, NULL, params, NULL, NULL, 0);
        }

        if (!checkResult(res, PGRES_TUPLES_OK)) {
            return false;
        }

        int rows = PQntuples(res);

        /* If no items, return empty result */
        if (rows == 0) {
            PQclear(res);

            outResult->found = true;
            outResult->menu.menuId = 0;
            outResult->menu.pageOffset = pageOffset;
            outResult->menu.totalItems = 0;
            outResult->menu.itemCount = 0;
            outResult->menu.name[0] = '\0';
            return true;
        }

        outResult->found = true;
        outResult->menu.menuId = 0;
        outResult->menu.pageOffset = pageOffset;
        outResult->menu.totalItems = (rows > 0) ? atoi(PQgetvalue(res, 0, 6)) : 0;
        outResult->menu.name[0] = '\0';

        for (int i = 0; i < rows && i < DB_MAX_MENU_ITEMS; i++) {
            DBMenuItem *item = &outResult->menu.items[i];
            item->position = atoi(PQgetvalue(res, i, 0));  /* Use actual position from DB */

            const char *itemType = PQgetvalue(res, i, 1);
            const char *displayName = PQgetvalue(res, i, 2);
            const char *soundAlias = PQgetvalue(res, i, 3);
            const char *nestedMenuIdStr = PQgetvalue(res, i, 4);
            const char *playlistIdStr = PQgetvalue(res, i, 5);

            strncpy(item->name, displayName ? displayName : "", sizeof(item->name) - 1);
            item->name[sizeof(item->name) - 1] = '\0';

            if (strcmp(itemType, "sound") == 0) {
                item->itemType = DB_MENU_ITEM_SOUND;
                strncpy(item->soundAlias, soundAlias ? soundAlias : "", sizeof(item->soundAlias) - 1);
                item->soundAlias[sizeof(item->soundAlias) - 1] = '\0';
                item->nestedMenuId = 0;
            } else if (strcmp(itemType, "menu") == 0) {
                item->itemType = DB_MENU_ITEM_MENU;
                item->soundAlias[0] = '\0';
                item->nestedMenuId = nestedMenuIdStr ? atoi(nestedMenuIdStr) : 0;
            } else if (strcmp(itemType, "playlist") == 0) {
                /* Playlists are navigable like menus, but use negative ID */
                item->itemType = DB_MENU_ITEM_MENU;
                item->soundAlias[0] = '\0';
                item->nestedMenuId = playlistIdStr ? -atoi(playlistIdStr) : 0;  /* Negative = playlist */
            }

            outResult->menu.itemCount++;
        }

        PQclear(res);
    } else if (menuId < 0) {
        /* Negative menuId = playlist ID, show playlist contents
         * Strategy:
         * 1. First try to load snapshot data (for displayName overrides and fallback)
         * 2. Try live playlist query
         * 3. If live query fails/empty, use snapshot as fallback
         * 4. If both fail, return empty result
         */
        int playlistId = -menuId;
        char playlistIdStr[16];
        snprintf(playlistIdStr, sizeof(playlistIdStr), "%d", playlistId);

        /* Step 1: Try to get snapshot data for this playlist (for displayNames and fallback)
         * Query the menu item that references this playlist to get its snapshot.
         * Use PostgreSQL's jsonb operators to extract snapshot items.
         */
        PGresult *snapshotRes = NULL;
        bool hasSnapshot = false;
        char snapshotPlaylistName[33] = "";

        if (isServerMenu) {
            const char *snapParams[1] = { playlistIdStr };
            snapshotRes = PQexecParams(g_db.conn,
                "SELECT "
                "  playlist_snapshot->'originalPlaylistName' as playlist_name, "
                "  elem->>'position' as position, "
                "  elem->>'originalAlias' as original_alias, "
                "  elem->>'displayName' as display_name, "
                "  elem->>'filePath' as file_path, "
                "  jsonb_array_length(playlist_snapshot->'items') as total_items "
                "FROM user_sound_menu_items, "
                "     jsonb_array_elements(playlist_snapshot->'items') as elem "
                "WHERE playlist_id = $1 "
                "  AND is_server_default = true "
                "  AND playlist_snapshot IS NOT NULL "
                "ORDER BY (elem->>'position')::int "
                "LIMIT 9",
                1, NULL, snapParams, NULL, NULL, 0);
        } else {
            const char *snapParams[2] = { guid, playlistIdStr };
            snapshotRes = PQexecParams(g_db.conn,
                "SELECT "
                "  playlist_snapshot->'originalPlaylistName' as playlist_name, "
                "  elem->>'position' as position, "
                "  elem->>'originalAlias' as original_alias, "
                "  elem->>'displayName' as display_name, "
                "  elem->>'filePath' as file_path, "
                "  jsonb_array_length(playlist_snapshot->'items') as total_items "
                "FROM user_sound_menu_items, "
                "     jsonb_array_elements(playlist_snapshot->'items') as elem "
                "WHERE user_guid = $1 "
                "  AND playlist_id = $2 "
                "  AND (is_server_default = false OR is_server_default IS NULL) "
                "  AND playlist_snapshot IS NOT NULL "
                "ORDER BY (elem->>'position')::int "
                "LIMIT 9",
                2, NULL, snapParams, NULL, NULL, 0);
        }

        int snapshotRows = 0;
        if (snapshotRes && PQresultStatus(snapshotRes) == PGRES_TUPLES_OK) {
            snapshotRows = PQntuples(snapshotRes);
            hasSnapshot = (snapshotRows > 0);
            if (hasSnapshot) {
                /* Extract playlist name from snapshot (remove JSON quotes) */
                const char *rawName = PQgetvalue(snapshotRes, 0, 0);
                if (rawName && rawName[0] == '"') {
                    /* Remove surrounding quotes from JSON string */
                    strncpy(snapshotPlaylistName, rawName + 1, sizeof(snapshotPlaylistName) - 1);
                    char *endQuote = strrchr(snapshotPlaylistName, '"');
                    if (endQuote) *endQuote = '\0';
                } else if (rawName) {
                    strncpy(snapshotPlaylistName, rawName, sizeof(snapshotPlaylistName) - 1);
                }
            }
        }

        /* Step 2: Try live playlist query */
        PGresult *res;
        if (isServerMenu) {
            /* Server playlist - no guid filter, playlist must be public or linked to server */
            const char *params[3] = { playlistIdStr, limitStr, offsetStr };
            res = PQexecParams(g_db.conn,
                "SELECT pi.order_number, us.alias, us.id, p.name, "
                "       (SELECT COUNT(*) FROM sound_playlist_items WHERE playlist_id = $1) as total_items "
                "FROM sound_playlist_items pi "
                "JOIN user_sounds us ON us.id = pi.user_sound_id "
                "JOIN sound_playlists p ON p.id = pi.playlist_id "
                "WHERE p.id = $1 "
                "ORDER BY pi.order_number "
                "LIMIT $2 OFFSET $3",
                3, NULL, params, NULL, NULL, 0);
        } else {
            /* Personal playlist - filter by guid */
            const char *params[4] = { guid, playlistIdStr, limitStr, offsetStr };
            res = PQexecParams(g_db.conn,
                "SELECT pi.order_number, us.alias, us.id, p.name, "
                "       (SELECT COUNT(*) FROM sound_playlist_items WHERE playlist_id = $2) as total_items "
                "FROM sound_playlist_items pi "
                "JOIN user_sounds us ON us.id = pi.user_sound_id "
                "JOIN sound_playlists p ON p.id = pi.playlist_id "
                "WHERE p.guid = $1 AND p.id = $2 "
                "ORDER BY pi.order_number "
                "LIMIT $3 OFFSET $4",
                4, NULL, params, NULL, NULL, 0);
        }

        if (!checkResult(res, PGRES_TUPLES_OK)) {
            if (snapshotRes) PQclear(snapshotRes);
            return false;
        }

        int rows = PQntuples(res);

        outResult->found = true;
        outResult->menu.menuId = menuId; /* Keep negative to indicate playlist */
        outResult->menu.pageOffset = pageOffset;

        if (rows > 0) {
            /* Use live playlist data, but apply displayName overrides from snapshot */
            outResult->menu.totalItems = atoi(PQgetvalue(res, 0, 4));
            strncpy(outResult->menu.name, PQgetvalue(res, 0, 3), sizeof(outResult->menu.name) - 1);

            for (int i = 0; i < rows && i < DB_MAX_MENU_ITEMS; i++) {
                DBMenuItem *item = &outResult->menu.items[i];
                item->position = i + 1;
                item->itemType = DB_MENU_ITEM_SOUND;
                const char *alias = PQgetvalue(res, i, 1);
                strncpy(item->soundAlias, alias, sizeof(item->soundAlias) - 1);

                /* Check for displayName override in snapshot */
                bool foundOverride = false;
                if (hasSnapshot) {
                    for (int j = 0; j < snapshotRows; j++) {
                        const char *snapAlias = PQgetvalue(snapshotRes, j, 2); /* originalAlias */
                        const char *snapDisplayName = PQgetvalue(snapshotRes, j, 3); /* displayName */
                        if (snapAlias && strcmp(snapAlias, alias) == 0) {
                            /* Found matching sound - check if displayName is set (not null) */
                            if (snapDisplayName && snapDisplayName[0] != '\0' && strcmp(snapDisplayName, "null") != 0) {
                                strncpy(item->name, snapDisplayName, sizeof(item->name) - 1);
                                foundOverride = true;
                            }
                            break;
                        }
                    }
                }
                if (!foundOverride) {
                    strncpy(item->name, alias, sizeof(item->name) - 1);
                }
                item->nestedMenuId = 0;
                outResult->menu.itemCount++;
            }
        } else if (hasSnapshot) {
            /* Step 3: Live playlist empty/inaccessible - use snapshot as fallback */
            outResult->menu.totalItems = atoi(PQgetvalue(snapshotRes, 0, 5));
            strncpy(outResult->menu.name, snapshotPlaylistName, sizeof(outResult->menu.name) - 1);

            for (int i = 0; i < snapshotRows && i < DB_MAX_MENU_ITEMS; i++) {
                DBMenuItem *item = &outResult->menu.items[i];
                item->position = i + 1;
                item->itemType = DB_MENU_ITEM_SOUND;

                const char *originalAlias = PQgetvalue(snapshotRes, i, 2);
                const char *displayName = PQgetvalue(snapshotRes, i, 3);

                /* Use displayName if set, otherwise originalAlias */
                if (displayName && displayName[0] != '\0' && strcmp(displayName, "null") != 0) {
                    strncpy(item->name, displayName, sizeof(item->name) - 1);
                } else {
                    strncpy(item->name, originalAlias ? originalAlias : "Unknown", sizeof(item->name) - 1);
                }

                /* For soundAlias, always use originalAlias (needed for playback lookup) */
                strncpy(item->soundAlias, originalAlias ? originalAlias : "", sizeof(item->soundAlias) - 1);
                item->nestedMenuId = 0;
                outResult->menu.itemCount++;
            }
        } else {
            /* No live data and no snapshot - empty playlist */
            outResult->menu.totalItems = 0;
            outResult->menu.name[0] = '\0';
        }

        PQclear(res);
        if (snapshotRes) PQclear(snapshotRes);
    } else {
        /* Specific menu: show its items (sounds, nested menus, and playlists)
         * For server menus we don't filter by user_guid, for personal menus we do
         */
        PGresult *res;
        if (isServerMenu) {
            /* Server menu - query by ID only, check is_server_default */
            const char *params[3] = { menuIdStr, limitStr, offsetStr };
            res = PQexecParams(g_db.conn,
                "SELECT item_position, item_type, display_name, sound_alias, nested_menu_id, menu_name, total_items FROM ("
                "  /* Sound items (item_type='sound') */"
                "  SELECT mi.item_position, 'sound'::text as item_type, "
                "         COALESCE(mi.display_name, us.alias) as display_name, "
                "         us.alias as sound_alias, NULL::int as nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id = m.id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
                "  JOIN user_sounds us ON us.id = mi.sound_id "
                "  WHERE m.id = $1 AND m.is_server_default = true AND mi.item_type = 'sound' "
                "  UNION ALL "
                "  /* Nested menu items (item_type='menu') */"
                "  SELECT mi.item_position, 'menu'::text as item_type, "
                "         COALESCE(mi.display_name, nm.menu_name) as display_name, "
                "         NULL as sound_alias, mi.nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id = m.id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
                "  JOIN user_sound_menus nm ON nm.id = mi.nested_menu_id "
                "  WHERE m.id = $1 AND m.is_server_default = true AND mi.item_type = 'menu' "
                "  UNION ALL "
                "  /* Playlist items (item_type='playlist') - show as navigable item with negative playlist ID */"
                "  SELECT mi.item_position, 'playlist'::text as item_type, "
                "         COALESCE(mi.display_name, p.name) as display_name, "
                "         NULL as sound_alias, -mi.playlist_id as nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id = m.id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
                "  JOIN sound_playlists p ON p.id = mi.playlist_id "
                "  WHERE m.id = $1 AND m.is_server_default = true AND mi.item_type = 'playlist' "
                "  UNION ALL "
                "  /* Playlist-backed menu (menu.playlist_id set, entire menu is a playlist) */"
                "  SELECT pi.order_number as item_position, 'sound'::text as item_type, "
                "         us.alias as display_name, us.alias as sound_alias, NULL::int as nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM sound_playlist_items WHERE playlist_id = m.playlist_id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN sound_playlist_items pi ON pi.playlist_id = m.playlist_id "
                "  JOIN user_sounds us ON us.id = pi.user_sound_id "
                "  WHERE m.id = $1 AND m.is_server_default = true AND m.playlist_id IS NOT NULL "
                ") combined ORDER BY item_position LIMIT $2 OFFSET $3",
                3, NULL, params, NULL, NULL, 0);
        } else {
            /* Personal menu - query by user_guid and ID */
            const char *params[4] = { guid, menuIdStr, limitStr, offsetStr };
            res = PQexecParams(g_db.conn,
                "SELECT item_position, item_type, display_name, sound_alias, nested_menu_id, menu_name, total_items FROM ("
                "  /* Sound items (item_type='sound') */"
                "  SELECT mi.item_position, 'sound'::text as item_type, "
                "         COALESCE(mi.display_name, us.alias) as display_name, "
                "         us.alias as sound_alias, NULL::int as nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id = m.id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
                "  JOIN user_sounds us ON us.id = mi.sound_id "
                "  WHERE m.user_guid = $1 AND m.id = $2 AND m.is_server_default = false AND mi.item_type = 'sound' "
                "  UNION ALL "
                "  /* Nested menu items (item_type='menu') */"
                "  SELECT mi.item_position, 'menu'::text as item_type, "
                "         COALESCE(mi.display_name, nm.menu_name) as display_name, "
                "         NULL as sound_alias, mi.nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id = m.id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
                "  JOIN user_sound_menus nm ON nm.id = mi.nested_menu_id "
                "  WHERE m.user_guid = $1 AND m.id = $2 AND m.is_server_default = false AND mi.item_type = 'menu' "
                "  UNION ALL "
                "  /* Playlist items (item_type='playlist') - show as navigable item with negative playlist ID */"
                "  SELECT mi.item_position, 'playlist'::text as item_type, "
                "         COALESCE(mi.display_name, p.name) as display_name, "
                "         NULL as sound_alias, -mi.playlist_id as nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM user_sound_menu_items WHERE menu_id = m.id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN user_sound_menu_items mi ON mi.menu_id = m.id "
                "  JOIN sound_playlists p ON p.id = mi.playlist_id "
                "  WHERE m.user_guid = $1 AND m.id = $2 AND m.is_server_default = false AND mi.item_type = 'playlist' "
                "  UNION ALL "
                "  /* Playlist-backed menu (menu.playlist_id set, entire menu is a playlist) */"
                "  SELECT pi.order_number as item_position, 'sound'::text as item_type, "
                "         us.alias as display_name, us.alias as sound_alias, NULL::int as nested_menu_id, "
                "         m.menu_name, "
                "         (SELECT COUNT(*) FROM sound_playlist_items WHERE playlist_id = m.playlist_id) as total_items "
                "  FROM user_sound_menus m "
                "  JOIN sound_playlist_items pi ON pi.playlist_id = m.playlist_id "
                "  JOIN user_sounds us ON us.id = pi.user_sound_id "
                "  WHERE m.user_guid = $1 AND m.id = $2 AND m.is_server_default = false AND m.playlist_id IS NOT NULL "
                ") combined ORDER BY item_position LIMIT $3 OFFSET $4",
                4, NULL, params, NULL, NULL, 0);
        }

        if (!checkResult(res, PGRES_TUPLES_OK)) {
            return false;
        }

        int rows = PQntuples(res);
        if (rows == 0) {
            /* Menu exists but empty, or doesn't exist - check if menu exists */
            PQclear(res);
            if (isServerMenu) {
                /* Server menu - just check by ID */
                const char *checkParams[1] = { menuIdStr };
                res = PQexecParams(g_db.conn,
                    "SELECT menu_name FROM user_sound_menus WHERE id = $1 AND is_server_default = true",
                    1, NULL, checkParams, NULL, NULL, 0);
            } else {
                /* Personal menu - check by user_guid and ID */
                const char *checkParams[2] = { guid, menuIdStr };
                res = PQexecParams(g_db.conn,
                    "SELECT menu_name FROM user_sound_menus WHERE user_guid = $1 AND id = $2 AND is_server_default = false",
                    2, NULL, checkParams, NULL, NULL, 0);
            }
            if (checkResult(res, PGRES_TUPLES_OK) && PQntuples(res) > 0) {
                outResult->found = true;
                outResult->menu.menuId = menuId;
                strncpy(outResult->menu.name, PQgetvalue(res, 0, 0), sizeof(outResult->menu.name) - 1);
                outResult->menu.itemCount = 0;
                outResult->menu.totalItems = 0;
                outResult->menu.pageOffset = pageOffset;
            }
            PQclear(res);
            return outResult->found;
        }

        outResult->found = true;
        outResult->menu.menuId = menuId;
        outResult->menu.pageOffset = pageOffset;
        outResult->menu.totalItems = atoi(PQgetvalue(res, 0, 6));
        strncpy(outResult->menu.name, PQgetvalue(res, 0, 5), sizeof(outResult->menu.name) - 1);

        for (int i = 0; i < rows && i < DB_MAX_MENU_ITEMS; i++) {
            DBMenuItem *item = &outResult->menu.items[i];
            item->position = i + 1;  /* 1-9 for display */

            const char *typeStr = PQgetvalue(res, i, 1);
            if (strcmp(typeStr, "menu") == 0 || strcmp(typeStr, "playlist") == 0) {
                /* Both menus and playlists are navigable - playlists use negative IDs */
                item->itemType = DB_MENU_ITEM_MENU;
                item->nestedMenuId = PQgetisnull(res, i, 4) ? 0 : atoi(PQgetvalue(res, i, 4));
                item->soundAlias[0] = '\0';
            } else {
                item->itemType = DB_MENU_ITEM_SOUND;
                item->nestedMenuId = 0;
                if (!PQgetisnull(res, i, 3)) {
                    strncpy(item->soundAlias, PQgetvalue(res, i, 3), sizeof(item->soundAlias) - 1);
                }
            }

            if (!PQgetisnull(res, i, 2)) {
                strncpy(item->name, PQgetvalue(res, i, 2), sizeof(item->name) - 1);
            }

            outResult->menu.itemCount++;
        }

        PQclear(res);
    }

    return outResult->found;
}

/**
 * Get sound file path by database ID (user_sounds.id or sound_files.id for public).
 */
bool DB_GetSoundById(const char *guid, int soundId, char *outFilePath, int outLen,
                     char *outName, int nameLen) {
    if (!outFilePath || outLen < 1) return false;
    outFilePath[0] = '\0';
    if (outName && nameLen > 0) outName[0] = '\0';

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    char soundIdStr[16];
    snprintf(soundIdStr, sizeof(soundIdStr), "%d", soundId);

    /* First try: user's personal library by user_sounds.id */
    const char *params[2] = { guid, soundIdStr };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT sf.file_path, us.alias "
        "FROM user_sounds us "
        "JOIN sound_files sf ON sf.id = us.sound_file_id "
        "WHERE us.guid = $1 AND us.id = $2",
        2, NULL, params, NULL, NULL, 0);

    if (checkResult(res, PGRES_TUPLES_OK) && PQntuples(res) > 0) {
        strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
        outFilePath[outLen - 1] = '\0';
        if (outName && nameLen > 0) {
            strncpy(outName, PQgetvalue(res, 0, 1), nameLen - 1);
            outName[nameLen - 1] = '\0';
        }
        PQclear(res);
        return true;
    }
    PQclear(res);

    /* Second try: public sound by sound_files.id */
    const char *publicParams[1] = { soundIdStr };
    res = PQexecParams(g_db.conn,
        "SELECT file_path, original_name "
        "FROM sound_files "
        "WHERE id = $1 AND is_public = true",
        1, NULL, publicParams, NULL, NULL, 0);

    if (checkResult(res, PGRES_TUPLES_OK) && PQntuples(res) > 0) {
        strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
        outFilePath[outLen - 1] = '\0';
        if (outName && nameLen > 0) {
            strncpy(outName, PQgetvalue(res, 0, 1), nameLen - 1);
            outName[nameLen - 1] = '\0';
        }
        PQclear(res);
        return true;
    }
    PQclear(res);

    setError("Sound not found");
    return false;
}


/*
 * Quick Command operations (Phase 11: Chat-triggered sounds)
 */

/**
 * Get player's quick command prefix.
 * Returns true if a custom prefix was found, false if using default "@".
 */
bool DB_GetQuickCmdPrefix(const char *guid, char *outPrefix) {
    if (!outPrefix) return false;

    /* Default prefix */
    strcpy(outPrefix, "@");

    if (!guid || !guid[0]) return false;

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    const char *params[1] = { guid };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT quick_cmd_prefix FROM player_settings WHERE guid = $1",
        1, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) == 0 || PQgetisnull(res, 0, 0)) {
        PQclear(res);
        return false;  /* Use default */
    }

    const char *prefix = PQgetvalue(res, 0, 0);
    if (prefix && prefix[0]) {
        strncpy(outPrefix, prefix, 4);
        outPrefix[4] = '\0';
    }

    PQclear(res);
    return true;
}

/**
 * Look up a quick command alias for a player.
 * Checks quick_command_aliases table first, then falls back to public sounds.
 */
bool DB_LookupQuickCommand(const char *guid, const char *alias,
                           DBQuickCmdResult *outResult) {
    if (!outResult) return false;
    memset(outResult, 0, sizeof(*outResult));

    if (!guid || !guid[0] || !alias || !alias[0]) {
        setError("Invalid GUID or alias");
        return false;
    }

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Step 1: Check player's quick_command_aliases table */
    const char *params[2] = { guid, alias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT "
        "  COALESCE(sf1.file_path, sf2.file_path) AS file_path, "
        "  COALESCE(sf1.id, sf2.id) AS sound_file_id, "
        "  qca.chat_text "
        "FROM quick_command_aliases qca "
        "LEFT JOIN user_sounds us ON qca.user_sound_id = us.id "
        "LEFT JOIN sound_files sf1 ON us.sound_file_id = sf1.id "
        "LEFT JOIN sound_files sf2 ON qca.sound_file_id = sf2.id "
        "WHERE qca.guid = $1 AND LOWER(qca.alias) = LOWER($2)",
        2, NULL, params, NULL, NULL, 0);

    if (!checkResult(res, PGRES_TUPLES_OK)) {
        return false;
    }

    if (PQntuples(res) > 0) {
        const char *filePath = getField(res, 0, 0);
        if (filePath && filePath[0]) {
            strncpy(outResult->filePath, filePath, sizeof(outResult->filePath) - 1);
            outResult->soundFileId = getIntField(res, 0, 1);

            /* Get chat text (may be NULL) */
            if (!PQgetisnull(res, 0, 2)) {
                const char *chatText = PQgetvalue(res, 0, 2);
                if (chatText && chatText[0]) {
                    strncpy(outResult->chatText, chatText, sizeof(outResult->chatText) - 1);
                    outResult->hasChatText = true;
                }
            }

            PQclear(res);
            return true;
        }
    }
    PQclear(res);
    return false;
}

/**
 * Fuzzy search for public sounds by alias.
 * First tries exact match on original_name, then prefix match.
 * Note: Public fallback does NOT include chat text.
 */
bool DB_FuzzySearchPublicSound(const char *alias, char *outFilePath, int outLen,
                               int *outSoundFileId) {
    if (!outFilePath || outLen < 1) return false;
    outFilePath[0] = '\0';
    if (outSoundFileId) *outSoundFileId = 0;

    if (!alias || !alias[0]) {
        setError("Invalid alias");
        return false;
    }

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Step 1: Exact match on public sounds by original_name (case-insensitive) */
    const char *params[1] = { alias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT file_path, id FROM sound_files "
        "WHERE is_public = true AND LOWER(REPLACE(original_name, '.mp3', '')) = LOWER($1) "
        "LIMIT 1",
        1, NULL, params, NULL, NULL, 0);

    if (checkResult(res, PGRES_TUPLES_OK) && PQntuples(res) > 0) {
        strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
        outFilePath[outLen - 1] = '\0';
        if (outSoundFileId) {
            *outSoundFileId = atoi(PQgetvalue(res, 0, 1));
        }
        PQclear(res);
        return true;
    }
    PQclear(res);

    /* Step 2: Prefix match on public sounds (find shortest match) */
    char likePattern[64];
    snprintf(likePattern, sizeof(likePattern), "%s%%", alias);
    const char *fuzzyParams[1] = { likePattern };

    res = PQexecParams(g_db.conn,
        "SELECT file_path, id FROM sound_files "
        "WHERE is_public = true AND LOWER(original_name) LIKE LOWER($1) "
        "ORDER BY LENGTH(original_name) ASC LIMIT 1",
        1, NULL, fuzzyParams, NULL, NULL, 0);

    if (checkResult(res, PGRES_TUPLES_OK) && PQntuples(res) > 0) {
        strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
        outFilePath[outLen - 1] = '\0';
        if (outSoundFileId) {
            *outSoundFileId = atoi(PQgetvalue(res, 0, 1));
        }
        PQclear(res);
        return true;
    }
    PQclear(res);

    setError("Public sound not found");
    return false;
}

/**
 * Fuzzy search for a player's own sounds by alias.
 * First tries exact match, then prefix match on user_sounds.alias.
 */
bool DB_FuzzySearchUserSound(const char *guid, const char *alias,
                             char *outFilePath, int outLen, int *outSoundFileId) {
    if (!outFilePath || outLen < 1) return false;
    outFilePath[0] = '\0';
    if (outSoundFileId) *outSoundFileId = 0;

    if (!guid || !guid[0] || !alias || !alias[0]) {
        setError("Invalid GUID or alias");
        return false;
    }

    if (!DB_IsConnected()) {
        setError("Not connected to database");
        return false;
    }

    /* Step 1: Exact match on user's sounds by alias (case-insensitive) */
    const char *params[2] = { guid, alias };
    PGresult *res = PQexecParams(g_db.conn,
        "SELECT sf.file_path, sf.id FROM user_sounds us "
        "JOIN sound_files sf ON us.sound_file_id = sf.id "
        "WHERE us.guid = $1 AND LOWER(us.alias) = LOWER($2) "
        "LIMIT 1",
        2, NULL, params, NULL, NULL, 0);

    /* Note: checkResult clears res on failure, so only clear on success path */
    if (checkResult(res, PGRES_TUPLES_OK)) {
        if (PQntuples(res) > 0) {
            strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
            outFilePath[outLen - 1] = '\0';
            if (outSoundFileId) {
                *outSoundFileId = atoi(PQgetvalue(res, 0, 1));
            }
            PQclear(res);
            return true;
        }
        PQclear(res);
    }
    /* If checkResult failed, res was already cleared by checkResult */

    /* Step 2: Prefix match on user's sounds (find shortest match) */
    char likePattern[64];
    snprintf(likePattern, sizeof(likePattern), "%s%%", alias);
    const char *fuzzyParams[2] = { guid, likePattern };

    res = PQexecParams(g_db.conn,
        "SELECT sf.file_path, sf.id FROM user_sounds us "
        "JOIN sound_files sf ON us.sound_file_id = sf.id "
        "WHERE us.guid = $1 AND LOWER(us.alias) LIKE LOWER($2) "
        "ORDER BY LENGTH(us.alias) ASC LIMIT 1",
        2, NULL, fuzzyParams, NULL, NULL, 0);

    /* Note: checkResult clears res on failure, so only clear on success path */
    if (checkResult(res, PGRES_TUPLES_OK)) {
        if (PQntuples(res) > 0) {
            strncpy(outFilePath, PQgetvalue(res, 0, 0), outLen - 1);
            outFilePath[outLen - 1] = '\0';
            if (outSoundFileId) {
                *outSoundFileId = atoi(PQgetvalue(res, 0, 1));
            }
            PQclear(res);
            return true;
        }
        PQclear(res);
    }
    /* If checkResult failed, res was already cleared by checkResult */

    setError("User sound not found");
    return false;
}
