/**
 * @file db_manager.h
 * @brief PostgreSQL database connection manager for voice server
 *
 * Provides database connectivity for sound metadata storage.
 * Uses libpq for PostgreSQL communication.
 */

#ifndef DB_MANAGER_H
#define DB_MANAGER_H

#include <stdint.h>
#include <stdbool.h>
#include <time.h>

/* Forward declaration for SoundInfo (defined in sound_manager.h) */
struct SoundInfo_s;
typedef struct SoundInfo_s SoundInfo;

/*
 * Connection status
 */
typedef enum {
    DB_STATUS_DISCONNECTED = 0,
    DB_STATUS_CONNECTING,
    DB_STATUS_CONNECTED,
    DB_STATUS_ERROR
} DBStatus;

/*
 * Sound file record (from sound_files table)
 */
typedef struct {
    int         id;
    char        filename[65];           /* UUID-based filename */
    char        originalName[65];       /* Original upload name */
    char        filePath[513];          /* Full path to MP3 file */
    int         fileSize;               /* File size in bytes */
    int         durationSeconds;        /* Duration (calculated on add) */
    char        addedByGuid[33];        /* Who originally uploaded */
    int         referenceCount;         /* How many user_sounds reference this */
    bool        isPublic;               /* Available in public library */
    time_t      createdAt;
} DBSoundFile;

/*
 * User sound record (from user_sounds table)
 */
typedef struct {
    int         id;
    char        guid[33];               /* User's ET GUID */
    int         soundFileId;            /* Reference to sound_files.id */
    char        alias[33];              /* User's custom name for this sound */
    char        visibility[11];         /* 'private', 'shared', 'public' */
    time_t      createdAt;
    time_t      updatedAt;
    /* Joined fields from sound_files */
    char        filePath[513];          /* For playback */
    int         fileSize;               /* For display */
    int         durationSeconds;        /* For rate limiting */
} DBUserSound;

/*
 * Playlist record (from sound_playlists table)
 */
typedef struct {
    int         id;
    char        guid[33];               /* Owner's ET GUID */
    char        name[33];               /* Playlist name */
    char        description[256];       /* Optional description */
    bool        isPublic;               /* Server-wide public playlist */
    int         currentPosition;        /* For playback tracking */
    time_t      createdAt;
    time_t      updatedAt;
    int         soundCount;             /* Computed: number of sounds in playlist */
} DBPlaylist;

/*
 * Playlist item record (from sound_playlist_items table)
 */
typedef struct {
    int         id;
    int         playlistId;
    int         userSoundId;
    int         orderNumber;            /* User-editable order */
    time_t      addedAt;
    /* Joined fields */
    char        alias[33];              /* Sound alias */
    char        filePath[513];          /* For playback */
    int         durationSeconds;        /* For rate limiting */
} DBPlaylistItem;

/*
 * Share request record (from sound_shares table)
 */
typedef struct {
    int         id;
    int         soundFileId;
    char        fromGuid[33];           /* Who shared it */
    char        toGuid[33];             /* Who it's shared with */
    char        suggestedAlias[33];     /* Suggested name for recipient */
    char        status[11];             /* 'pending', 'accepted', 'rejected' */
    time_t      createdAt;
    time_t      respondedAt;
    /* Joined fields from sound_files */
    char        originalName[65];       /* For display */
    int         fileSize;
    char        fromPlayerName[65];     /* Sender's player name for display */
} DBShareRequest;

/*
 * Verification code record (from verification_codes table)
 */
typedef struct {
    int         id;
    char        guid[33];               /* ET GUID */
    char        code[7];                /* 6-char alphanumeric code */
    char        playerName[65];         /* In-game name at time of request */
    time_t      createdAt;
    time_t      expiresAt;              /* 10 minute expiry */
    bool        used;
} DBVerificationCode;

/*
 * Query result for sound listing
 */
#define DB_MAX_SOUNDS_PER_QUERY 100

typedef struct {
    DBUserSound sounds[DB_MAX_SOUNDS_PER_QUERY];
    int         count;
    int         totalCount;             /* Total matching (for pagination) */
} DBSoundListResult;

/*
 * Query result for playlist listing
 */
#define DB_MAX_PLAYLISTS_PER_QUERY 50

typedef struct {
    DBPlaylist  playlists[DB_MAX_PLAYLISTS_PER_QUERY];
    int         count;
} DBPlaylistListResult;

/*
 * Query result for playlist items
 */
typedef struct {
    DBPlaylistItem items[DB_MAX_SOUNDS_PER_QUERY];
    int         count;
} DBPlaylistItemsResult;

/*
 * Query result for pending shares
 */
#define DB_MAX_SHARES_PER_QUERY 50

typedef struct {
    DBShareRequest shares[DB_MAX_SHARES_PER_QUERY];
    int         count;
} DBShareListResult;


/*
 * Database connection API
 */

/**
 * Initialize the database connection.
 * Reads DATABASE_URL from environment if connString is NULL.
 * @param connString PostgreSQL connection string (or NULL for env var)
 * @return true on success
 */
bool DB_Init(const char *connString);

/**
 * Shutdown the database connection.
 */
void DB_Shutdown(void);

/**
 * Check if database is connected.
 * @return true if connected
 */
bool DB_IsConnected(void);

/**
 * Get current connection status.
 * @return DBStatus enum value
 */
DBStatus DB_GetStatus(void);

/**
 * Get last error message.
 * @return Error message string (may be empty)
 */
const char* DB_GetLastError(void);

/**
 * Reconnect to database if disconnected.
 * @return true on success
 */
bool DB_Reconnect(void);

/**
 * Get the raw PostgreSQL connection handle.
 * For use by modules that need direct database access.
 * @return PGconn pointer, or NULL if not connected
 */
struct pg_conn* DB_GetConnection(void);


/*
 * Sound file operations
 */

/**
 * Add a new sound file to the database.
 * Creates both sound_files and user_sounds entries.
 * @param guid Player GUID who uploaded
 * @param alias User's name for the sound
 * @param filename UUID-based filename on disk
 * @param originalName Original upload name
 * @param filePath Full path to MP3 file
 * @param fileSize File size in bytes
 * @param durationSeconds Audio duration
 * @param outSoundFileId Output: the created sound_files.id
 * @return true on success
 */
bool DB_AddSound(const char *guid, const char *alias,
                 const char *filename, const char *originalName,
                 const char *filePath, int fileSize, int durationSeconds,
                 int *outSoundFileId);

/**
 * Get a sound by user GUID and alias.
 * @param guid Player GUID
 * @param alias Sound alias
 * @param outSound Output sound record
 * @return true if found
 */
bool DB_GetSoundByAlias(const char *guid, const char *alias, DBUserSound *outSound);

/**
 * List all sounds for a player.
 * @param guid Player GUID
 * @param outResult Output result with sounds array
 * @return Number of sounds found, -1 on error
 */
int DB_ListSounds(const char *guid, DBSoundListResult *outResult);

/**
 * Get sound count for a player.
 * @param guid Player GUID
 * @return Number of sounds, -1 on error
 */
int DB_GetSoundCount(const char *guid);

/**
 * List all sounds for a player (includes shared sounds).
 * @param guid Player GUID
 * @param outList Output array for sound info
 * @param maxCount Maximum number of sounds to return
 * @return Number of sounds, -1 on error
 */
int DB_ListUserSounds(const char *guid, SoundInfo *outList, int maxCount);

/**
 * Delete a sound from user's library.
 * Handles reference counting and file deletion logic.
 * @param guid Player GUID
 * @param alias Sound alias
 * @param outFilePath If non-NULL and file should be deleted, receives file path
 * @return true on success
 */
bool DB_DeleteSound(const char *guid, const char *alias, char *outFilePath);

/**
 * Rename a sound (update alias).
 * @param guid Player GUID
 * @param oldAlias Current alias
 * @param newAlias New alias
 * @return true on success
 */
bool DB_RenameSound(const char *guid, const char *oldAlias, const char *newAlias);

/**
 * Set sound visibility.
 * @param guid Player GUID
 * @param alias Sound alias
 * @param visibility New visibility: "private", "shared", or "public"
 * @return true on success
 */
bool DB_SetVisibility(const char *guid, const char *alias, const char *visibility);


/*
 * Public library operations
 */

/**
 * List public sounds.
 * @param outResult Output result with sounds array
 * @param limit Max sounds to return
 * @param offset Offset for pagination
 * @return Number of sounds found, -1 on error
 */
int DB_ListPublicSounds(DBSoundListResult *outResult, int limit, int offset);

/**
 * Add a public sound to user's library.
 * Creates new user_sounds entry and increments reference_count.
 * @param guid Player GUID
 * @param soundFileId ID of the sound_files record to add
 * @param alias User's alias for the sound
 * @return true on success
 */
bool DB_AddFromPublic(const char *guid, int soundFileId, const char *alias);

/**
 * Get a public sound by its original name (for playback fallback).
 * @param name Sound name to search for (matches original_name without .mp3)
 * @param outFilePath Output buffer for file path
 * @param outLen Output buffer length
 * @return true if found
 */
bool DB_GetPublicSoundByName(const char *name, char *outFilePath, int outLen);

/**
 * Find a sound by alias in user's local library and playlists.
 * Search order: 1) user's direct sounds, 2) sounds in user's playlists.
 * @param guid Player GUID
 * @param alias Sound alias to search for
 * @param outFilePath Output buffer for file path
 * @param outLen Output buffer length
 * @return true if found
 */
bool DB_FindSoundByAlias(const char *guid, const char *alias, char *outFilePath, int outLen);

/**
 * Find a sound by alias in all public sounds and public playlists.
 * Search order: 1) public sound_files by original_name, 2) public user aliases,
 *               3) sounds in public playlists.
 * @param alias Sound alias to search for
 * @param outFilePath Output buffer for file path
 * @param outLen Output buffer length
 * @return true if found
 */
bool DB_FindPublicSoundByAlias(const char *alias, char *outFilePath, int outLen);


/*
 * Playlist operations
 */

/**
 * Create a new playlist.
 * @param guid Player GUID
 * @param name Playlist name
 * @param description Optional description (can be NULL)
 * @param outPlaylistId Output: the created playlist ID
 * @return true on success
 */
bool DB_CreatePlaylist(const char *guid, const char *name,
                       const char *description, int *outPlaylistId);

/**
 * Delete a playlist.
 * @param guid Player GUID (for ownership check)
 * @param name Playlist name
 * @return true on success
 */
bool DB_DeletePlaylist(const char *guid, const char *name);

/**
 * List all playlists for a player.
 * @param guid Player GUID
 * @param outResult Output result with playlists array
 * @return Number of playlists found, -1 on error
 */
int DB_ListPlaylists(const char *guid, DBPlaylistListResult *outResult);

/**
 * Get sounds in a playlist.
 * @param guid Player GUID (for ownership check)
 * @param playlistName Playlist name
 * @param outResult Output result with items array
 * @return Number of items found, -1 on error
 */
int DB_GetPlaylistSounds(const char *guid, const char *playlistName,
                         DBPlaylistItemsResult *outResult);

/**
 * Add a sound to a playlist.
 * @param guid Player GUID
 * @param playlistName Playlist name
 * @param soundAlias Sound alias to add
 * @return true on success
 */
bool DB_AddToPlaylist(const char *guid, const char *playlistName,
                      const char *soundAlias);

/**
 * Remove a sound from a playlist.
 * @param guid Player GUID
 * @param playlistName Playlist name
 * @param soundAlias Sound alias to remove
 * @return true on success
 */
bool DB_RemoveFromPlaylist(const char *guid, const char *playlistName,
                           const char *soundAlias);

/**
 * Reorder sounds in a playlist.
 * @param guid Player GUID
 * @param playlistName Playlist name
 * @param soundAliases Array of sound aliases in new order
 * @param count Number of sounds
 * @return true on success
 */
bool DB_ReorderPlaylist(const char *guid, const char *playlistName,
                        const char **soundAliases, int count);

/**
 * Get current playlist position.
 * @param guid Player GUID
 * @param playlistName Playlist name
 * @return Current position (1-based), -1 on error
 */
int DB_GetPlaylistPosition(const char *guid, const char *playlistName);

/**
 * Set current playlist position.
 * @param guid Player GUID
 * @param playlistName Playlist name
 * @param position New position (1-based)
 * @return true on success
 */
bool DB_SetPlaylistPosition(const char *guid, const char *playlistName, int position);

/**
 * Get sound at playlist position for playback.
 * @param guid Player GUID
 * @param playlistName Playlist name
 * @param position Position to get (1-based, or 0 for current)
 * @param outItem Output playlist item
 * @return true if found
 */
bool DB_GetPlaylistSoundAtPosition(const char *guid, const char *playlistName,
                                   int position, DBPlaylistItem *outItem);

/**
 * List public playlists.
 * @param outResult Output result with playlists array
 * @return Number of playlists found, -1 on error
 */
int DB_ListPublicPlaylists(DBPlaylistListResult *outResult);

/**
 * Get sounds from a public playlist by name.
 * @param playlistName Playlist name
 * @param outResult Output result with items array
 * @return Number of items found, -1 on error
 */
int DB_GetPublicPlaylistSounds(const char *playlistName, DBPlaylistItemsResult *outResult);

/**
 * Get sound at position from a public playlist.
 * @param playlistName Playlist name
 * @param position Position to get (1-based)
 * @param outItem Output playlist item
 * @return true if found
 */
bool DB_GetPublicPlaylistSoundAtPosition(const char *playlistName, int position,
                                         DBPlaylistItem *outItem);

/**
 * Set playlist visibility.
 * @param guid Player GUID (for ownership check)
 * @param playlistName Playlist name
 * @param isPublic true for public, false for private
 * @return true on success
 */
bool DB_SetPlaylistVisibility(const char *guid, const char *playlistName, bool isPublic);


/*
 * Share operations
 */

/**
 * Create a share request.
 * @param fromGuid Sender GUID
 * @param toGuid Recipient GUID
 * @param soundAlias Sound to share
 * @param suggestedAlias Suggested alias for recipient
 * @param fromPlayerName Sender's player name (for display)
 * @return true on success
 */
bool DB_CreateShare(const char *fromGuid, const char *toGuid,
                    const char *soundAlias, const char *suggestedAlias,
                    const char *fromPlayerName);

/**
 * List pending share requests for a player.
 * @param toGuid Recipient GUID
 * @param outResult Output result with shares array
 * @return Number of pending shares, -1 on error
 */
int DB_ListPendingShares(const char *toGuid, DBShareListResult *outResult);

/**
 * Accept a share request.
 * @param toGuid Recipient GUID
 * @param fromGuid Sender GUID
 * @param soundFileId Sound file ID
 * @param alias Alias to use for the sound
 * @return true on success
 */
bool DB_AcceptShare(const char *toGuid, const char *fromGuid,
                    int soundFileId, const char *alias);

/**
 * Reject a share request.
 * @param toGuid Recipient GUID
 * @param fromGuid Sender GUID
 * @param soundFileId Sound file ID
 * @return true on success
 */
bool DB_RejectShare(const char *toGuid, const char *fromGuid, int soundFileId);


/*
 * Registration/verification operations
 */

/**
 * Create a verification code for in-game registration.
 * @param guid Player GUID
 * @param playerName Player's current in-game name
 * @param outCode Output: 6-character code
 * @return true on success
 */
bool DB_CreateVerificationCode(const char *guid, const char *playerName,
                               char *outCode);

/**
 * Verify a registration code.
 * @param code 6-character code
 * @param outGuid Output: GUID associated with code
 * @param outPlayerName Output: Player name at registration
 * @return true if code is valid and not expired
 */
bool DB_VerifyCode(const char *code, char *outGuid, char *outPlayerName);

/**
 * Mark a verification code as used.
 * @param code 6-character code
 * @return true on success
 */
bool DB_MarkCodeUsed(const char *code);


/*
 * Utility functions
 */

/**
 * Escape a string for SQL queries.
 * @param str Input string
 * @param outEscaped Output buffer (should be 2x input length + 1)
 * @param outLen Output buffer length
 */
void DB_EscapeString(const char *str, char *outEscaped, int outLen);

/**
 * Execute a raw query (for debugging/admin).
 * @param query SQL query
 * @return true on success
 */
bool DB_ExecuteRaw(const char *query);


/*
 * Dynamic sound menu structures and operations (Phase 9: Hierarchical)
 */

#define DB_MAX_MENU_ITEMS 9
#define DB_MAX_MENUS 9
#define DB_MENU_ITEM_SOUND 0
#define DB_MENU_ITEM_MENU  1

typedef struct {
    int         position;           /* 1-9 position in current page */
    int         itemType;           /* 0=sound, 1=menu/playlist */
    char        name[33];           /* Display name */
    char        soundAlias[33];     /* For sounds: alias to play */
    int         nestedMenuId;       /* For menus: ID to navigate to */
} DBMenuItem;

typedef struct {
    int         menuId;             /* Database menu ID (0 = root) */
    int         position;           /* Position in parent menu */
    char        name[33];           /* Menu name */
    bool        isPlaylist;         /* Backed by playlist (auto-populated) */
    int         itemCount;          /* Items in this page */
    int         totalItems;         /* Total items in menu */
    int         pageOffset;         /* Current pagination offset */
    DBMenuItem  items[DB_MAX_MENU_ITEMS];
} DBMenu;

typedef struct {
    DBMenu      menus[DB_MAX_MENUS];
    int         count;
} DBMenuResult;

/* Hierarchical menu query result */
typedef struct {
    DBMenu      menu;               /* Single menu context */
    bool        found;              /* Whether menu was found */
} DBMenuPageResult;

/**
 * Get user's sound menus with items populated (legacy - root menus only).
 * @param guid Player GUID
 * @param outResult Output result (caller must provide pointer)
 * @return true on success
 */
bool DB_GetUserMenus(const char *guid, DBMenuResult *outResult);

/**
 * Get the sound file path for a menu item.
 * @param guid Player GUID
 * @param menuPos Menu position (1-9)
 * @param itemPos Item position (1-9)
 * @param outFilePath Output buffer for file path
 * @param outLen Output buffer length
 * @return true if found
 */
bool DB_GetMenuItemSound(const char *guid, int menuPos, int itemPos,
                         char *outFilePath, int outLen);

/**
 * Get a page of menu items for hierarchical navigation.
 * @param guid Player GUID (used for personal menus, ignored for server menus)
 * @param menuId Menu ID (0 = root level menus)
 * @param pageOffset Starting offset (0, 9, 18, ...)
 * @param isServerMenu If true, return server default menus (is_server_default=true)
 *                     If false, return player's personal menus (is_server_default=false)
 * @param outResult Output result with menu data
 * @return true if menu found
 */
bool DB_GetMenuPage(const char *guid, int menuId, int pageOffset, bool isServerMenu, DBMenuPageResult *outResult);

/**
 * Get sound file path by user_sounds.id or sound_files.id.
 * First checks user's personal library, then public sounds.
 * @param guid Player GUID
 * @param soundId Database ID (user_sounds.id or sound_files.id for public)
 * @param outFilePath Output buffer for file path
 * @param outLen Output buffer length
 * @param outName Output buffer for sound name (can be NULL)
 * @param nameLen Name buffer length
 * @return true if found
 */
bool DB_GetSoundById(const char *guid, int soundId, char *outFilePath, int outLen,
                     char *outName, int nameLen);

#endif /* DB_MANAGER_H */
