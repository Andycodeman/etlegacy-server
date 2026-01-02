import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sounds } from '../api/client';
import type { SoundMenu, SoundMenuItem, UserSound, PlaylistSnapshotItem } from '../api/client';

type MenuMode = 'personal' | 'server';

interface SoundMenuEditorProps {
  userSounds: UserSound[];
  mode?: MenuMode;
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Breadcrumb item for navigation
interface BreadcrumbItem {
  id: number | null; // null for root
  name: string;
}

export default function SoundMenuEditor({ userSounds, mode = 'personal' }: SoundMenuEditorProps) {
  const queryClient = useQueryClient();
  const isServerMode = mode === 'server';
  const queryKey = isServerMode ? ['serverSoundMenus'] : ['soundMenus'];

  // Navigation state - breadcrumb path
  const [menuPath, setMenuPath] = useState<BreadcrumbItem[]>([{ id: null, name: 'Root' }]);
  const currentParentId = menuPath[menuPath.length - 1].id;

  // Edit slot state
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [editingSlotItem, setEditingSlotItem] = useState<SoundMenuItem | SoundMenu | null>(null);
  const [editMode, setEditMode] = useState<'view' | 'pick-type' | 'pick-sound' | 'pick-playlist' | 'pick-menu' | 'create-menu' | 'edit-playlist-sounds'>('view');
  const [searchQuery, setSearchQuery] = useState('');
  const [newMenuName, setNewMenuName] = useState('');

  // Playlist snapshot editing state
  const [editingSnapshotItems, setEditingSnapshotItems] = useState<PlaylistSnapshotItem[]>([]);

  // Error state
  const [error, setError] = useState('');

  // Inline rename state (for renaming items directly in the slot view)
  // For menus: renamingItemId is the menu ID. For sounds/playlists at root: it's the root item ID.
  const [renamingItemId, setRenamingItemId] = useState<number | null>(null);
  const [renamingItemType, setRenamingItemType] = useState<'menu' | 'root-item' | 'menu-item' | null>(null);
  const [renamingItemName, setRenamingItemName] = useState('');

  // Fetch all menus (used for navigating into menus from root items)
  const { isLoading: menusLoading } = useQuery({
    queryKey: queryKey,
    queryFn: () => isServerMode ? sounds.getServerMenus() : sounds.listMenus(),
  });

  // Fetch playlists
  const { data: playlistsData } = useQuery({
    queryKey: ['playlists'],
    queryFn: sounds.playlists,
  });

  // Fetch root items (when at root level)
  const { data: rootItemsData } = useQuery({
    queryKey: [...queryKey, 'rootItems'],
    queryFn: () => isServerMode ? sounds.getServerRootItems() : sounds.getRootItems(),
  });

  // Fetch items for current parent menu (if navigated into a menu)
  const { data: currentMenuData } = useQuery({
    queryKey: [...queryKey, 'items', currentParentId],
    queryFn: async () => {
      if (currentParentId === null) return null;
      return isServerMode
        ? sounds.getServerMenu(currentParentId)
        : sounds.getMenu(currentParentId);
    },
    enabled: currentParentId !== null,
  });

  const playlists = playlistsData?.playlists || [];
  const rootItems = rootItemsData?.items || [];
  const currentMenuItems = currentMenuData?.items || [];

  // Get menus/items for current view
  const getSlotContent = useCallback((position: number): { type: 'menu' | 'sound' | 'playlist' | 'empty'; item?: SoundMenu | SoundMenuItem } => {
    if (currentParentId === null) {
      // At root - show root items at this position
      const item = rootItems.find((i: SoundMenuItem) => i.itemPosition === position);
      if (item) {
        if (item.itemType === 'sound') {
          return { type: 'sound', item };
        } else if (item.itemType === 'playlist') {
          return { type: 'playlist', item };
        } else if (item.itemType === 'menu') {
          return { type: 'menu', item };
        }
      }
    } else {
      // Inside a menu - show items at this position
      const item = currentMenuItems.find(i => i.itemPosition === position);
      if (item) {
        if (item.itemType === 'sound') {
          return { type: 'sound', item };
        } else if (item.itemType === 'playlist') {
          return { type: 'playlist', item };
        } else if (item.itemType === 'menu') {
          return { type: 'menu', item };
        }
      }
    }
    return { type: 'empty' };
  }, [rootItems, currentMenuItems, currentParentId]);

  // Helper to remove existing content at a position before adding new content
  // Pass existingItem to avoid stale closure issues
  const removeExistingContent = async (existingItem: SoundMenu | SoundMenuItem | null, parentId: number | null) => {
    if (!existingItem) return;

    if (parentId === null) {
      // At root - delete the root item
      const item = existingItem as SoundMenuItem;
      if (isServerMode) {
        await sounds.removeServerRootItem(item.id);
      } else {
        await sounds.removeRootItem(item.id);
      }
    } else {
      // Inside a menu - remove the item
      const item = existingItem as SoundMenuItem;
      if (isServerMode) {
        await sounds.removeServerMenuItem(parentId, item.id);
      } else {
        await sounds.removeMenuItem(parentId, item.id);
      }
    }
  };

  // Mutations
  const createMenuMutation = useMutation({
    mutationFn: async ({ name, position, parentId, existingItem }: { name: string; position: number; parentId: number | null; existingItem?: SoundMenu | SoundMenuItem | null }) => {
      // First remove any existing content at this position
      if (existingItem) {
        await removeExistingContent(existingItem, parentId);
      }

      if (parentId === null) {
        // At root - create a menu and add it as a root item
        const menuResult = isServerMode
          ? await sounds.createServerMenu({ menuName: name, menuPosition: 0 }) // position 0 = not directly assigned
          : await sounds.createMenu(name, 0, null, null);
        const menuId = menuResult.menu.id;
        // Now add the menu as a root item at the specified position
        if (isServerMode) {
          await sounds.addServerRootMenu(menuId, position, name);
        } else {
          await sounds.addRootMenu(menuId, position, name);
        }
        return menuResult;
      } else {
        // Inside a menu - create nested menu
        if (isServerMode) {
          return sounds.createServerMenu({ menuName: name, menuPosition: position });
        }
        return sounds.createMenu(name, position, null, parentId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      if (currentParentId !== null) {
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'items', currentParentId] });
      }
      closeEditSlot();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Inline rename menu mutation (updates the menu's actual name)
  const renameMenuMutation = useMutation({
    mutationFn: async ({ menuId, menuName }: { menuId: number; menuName: string }) => {
      if (isServerMode) {
        return sounds.updateServerMenu(menuId, { menuName });
      }
      return sounds.updateMenu(menuId, { menuName });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      if (currentParentId !== null) {
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'items', currentParentId] });
      }
      setRenamingItemId(null);
      setRenamingItemType(null);
      setRenamingItemName('');
    },
    onError: (err: Error) => setError(err.message),
  });

  // Inline rename root item mutation (updates displayName for sounds/playlists at root)
  const renameRootItemMutation = useMutation({
    mutationFn: async ({ itemId, displayName }: { itemId: number; displayName: string }) => {
      if (isServerMode) {
        return sounds.updateServerRootItem(itemId, { displayName });
      }
      return sounds.updateRootItem(itemId, { displayName });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      setRenamingItemId(null);
      setRenamingItemType(null);
      setRenamingItemName('');
    },
    onError: (err: Error) => setError(err.message),
  });

  // Inline rename menu item mutation (updates displayName for sounds/playlists inside a menu)
  const renameMenuItemMutation = useMutation({
    mutationFn: async ({ menuId, itemId, displayName }: { menuId: number; itemId: number; displayName: string }) => {
      return sounds.updateMenuItem(menuId, itemId, { displayName });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      if (currentParentId !== null) {
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'items', currentParentId] });
      }
      setRenamingItemId(null);
      setRenamingItemType(null);
      setRenamingItemName('');
    },
    onError: (err: Error) => setError(err.message),
  });

  // Add sound to current menu or root
  const addSoundMutation = useMutation({
    mutationFn: async ({ soundId, soundAlias, position, existingItem }: { soundId: number; soundAlias: string; position: number; existingItem?: SoundMenu | SoundMenuItem | null }) => {
      // First remove any existing content at this position
      if (existingItem) {
        await removeExistingContent(existingItem, currentParentId);
      }

      if (currentParentId === null) {
        // At root - add sound directly as root item
        if (isServerMode) {
          await sounds.addServerRootSound(soundId, position, soundAlias);
        } else {
          await sounds.addRootSound(soundAlias, position);
        }
        return { success: true };
      } else {
        // Inside a menu - add sound item
        if (isServerMode) {
          await sounds.addSoundToServerMenu(currentParentId, soundId, position);
        } else {
          await sounds.addMenuItem(currentParentId, soundAlias, position);
        }
        return { success: true };
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      if (currentParentId !== null) {
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'items', currentParentId] });
      }
      closeEditSlot();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Add playlist to current menu or root
  const addPlaylistMutation = useMutation({
    mutationFn: async ({ playlistId, playlistName, position, existingItem }: { playlistId: number; playlistName: string; position: number; existingItem?: SoundMenu | SoundMenuItem | null }) => {
      // First remove any existing content at this position
      if (existingItem) {
        await removeExistingContent(existingItem, currentParentId);
      }

      if (currentParentId === null) {
        // At root - add playlist directly as root item
        if (isServerMode) {
          await sounds.addServerRootPlaylist(playlistId, position, playlistName);
        } else {
          await sounds.addRootPlaylist(playlistId, position, playlistName);
        }
      } else {
        // Inside a menu - add playlist item
        if (isServerMode) {
          await sounds.addPlaylistToServerMenu(currentParentId, playlistId, position);
        } else {
          await sounds.addPlaylistMenuItem(currentParentId, playlistId, position);
        }
      }
      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      if (currentParentId !== null) {
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'items', currentParentId] });
      }
      closeEditSlot();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Remove item from menu
  const removeItemMutation = useMutation({
    mutationFn: ({ menuId, itemId }: { menuId: number; itemId: number }) =>
      isServerMode
        ? sounds.removeServerMenuItem(menuId, itemId)
        : sounds.removeMenuItem(menuId, itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      if (currentParentId !== null) {
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'items', currentParentId] });
      }
      closeEditSlot();
    },
    onError: (err: Error) => setError(err.message),
  });

  // Swap two items/menus positions
  const swapPositionsMutation = useMutation({
    mutationFn: async ({ fromPos, toPos }: { fromPos: number; toPos: number }) => {
      const fromContent = getSlotContent(fromPos);
      const toContent = getSlotContent(toPos);

      if (currentParentId === null) {
        // At root level - swapping root items
        const fromItem = fromContent.item as SoundMenuItem | undefined;
        const toItem = toContent.item as SoundMenuItem | undefined;

        // Move "from" to a temp position (0), move "to" to "from", move temp to "to"
        if (fromItem && toItem) {
          // Both slots have items - swap them
          if (isServerMode) {
            await sounds.updateServerRootItem(fromItem.id, { itemPosition: 0 });
            await sounds.updateServerRootItem(toItem.id, { itemPosition: fromPos });
            await sounds.updateServerRootItem(fromItem.id, { itemPosition: toPos });
          } else {
            await sounds.updateRootItem(fromItem.id, { itemPosition: 0 });
            await sounds.updateRootItem(toItem.id, { itemPosition: fromPos });
            await sounds.updateRootItem(fromItem.id, { itemPosition: toPos });
          }
        } else if (fromItem) {
          // Only from has an item - just move it
          if (isServerMode) {
            await sounds.updateServerRootItem(fromItem.id, { itemPosition: toPos });
          } else {
            await sounds.updateRootItem(fromItem.id, { itemPosition: toPos });
          }
        }
      } else {
        // Inside a menu - swapping items
        const fromItem = fromContent.item as SoundMenuItem | undefined;
        const toItem = toContent.item as SoundMenuItem | undefined;

        if (fromItem && toItem) {
          // Both slots have items - swap them
          await sounds.updateMenuItem(currentParentId, fromItem.id, { itemPosition: 0 });
          await sounds.updateMenuItem(currentParentId, toItem.id, { itemPosition: fromPos });
          await sounds.updateMenuItem(currentParentId, fromItem.id, { itemPosition: toPos });
        } else if (fromItem) {
          // Only from has an item - just move it
          await sounds.updateMenuItem(currentParentId, fromItem.id, { itemPosition: toPos });
        }
      }
      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      if (currentParentId !== null) {
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'items', currentParentId] });
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  // Update playlist snapshot displayNames
  const updateSnapshotMutation = useMutation({
    mutationFn: async ({ itemId, items }: { itemId: number; items: { position: number; displayName: string | null }[] }) => {
      // Use server endpoint for server mode, personal endpoint for personal mode
      return isServerMode
        ? sounds.updateServerPlaylistSnapshot(itemId, items)
        : sounds.updatePlaylistSnapshot(itemId, items);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      setEditMode('view');
      setEditingSnapshotItems([]);
    },
    onError: (err: Error) => setError(err.message),
  });

  // Refresh playlist snapshot from live playlist
  const refreshSnapshotMutation = useMutation({
    mutationFn: async (itemId: number) => {
      // Use server endpoint for server mode, personal endpoint for personal mode
      return isServerMode
        ? sounds.refreshServerPlaylistSnapshot(itemId)
        : sounds.refreshPlaylistSnapshot(itemId);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
      // Update local state with the new snapshot
      if (data.snapshot?.items) {
        setEditingSnapshotItems(data.snapshot.items);
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  // Navigation handlers
  const navigateToMenu = (menu: SoundMenu | SoundMenuItem) => {
    const menuId = 'nestedMenuId' in menu ? menu.nestedMenuId : menu.id;
    const menuName = 'displayName' in menu ? menu.displayName : menu.menuName;
    if (menuId) {
      setMenuPath([...menuPath, { id: menuId, name: menuName }]);
    }
  };

  const navigateToBreadcrumb = (index: number) => {
    setMenuPath(menuPath.slice(0, index + 1));
  };

  // Edit slot handlers
  const openEditSlot = (position: number) => {
    const content = getSlotContent(position);
    setEditingSlot(position);
    setEditingSlotItem(content.item || null);
    setEditMode(content.type === 'empty' ? 'pick-type' : 'view');
    setSearchQuery('');
    setNewMenuName('');
    setError('');
  };

  const closeEditSlot = () => {
    setEditingSlot(null);
    setEditingSlotItem(null);
    setEditMode('view');
    setSearchQuery('');
    setNewMenuName('');
    setError('');
    setEditingSnapshotItems([]);
  };

  // Filter helpers
  const filteredSounds = userSounds.filter(s =>
    s.alias.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredPlaylists = playlists.filter(p =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (menusLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading menus...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">{isServerMode ? 'Server Sound Menus' : 'Sound Menus'}</h2>
        <p className="text-sm text-gray-400">
          Click a slot to assign sounds, playlists, or menus. Click 📁 to navigate into menus.
        </p>
      </div>

      {/* Breadcrumb Navigation */}
      {menuPath.length > 1 && (
        <div className="flex items-center gap-2 text-sm bg-gray-800 rounded-lg p-3">
          {menuPath.map((crumb, index) => (
            <div key={index} className="flex items-center gap-2">
              {index > 0 && <span className="text-gray-500">→</span>}
              <button
                onClick={() => navigateToBreadcrumb(index)}
                className={`px-2 py-1 rounded transition-colors ${
                  index === menuPath.length - 1
                    ? 'bg-orange-600 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-gray-700'
                }`}
              >
                {crumb.name}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && !editingSlot && (
        <div className="bg-red-900/30 border border-red-600 rounded-lg p-4">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {/* 9 Slots Grid */}
      <div className="grid gap-3">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((position) => {
          const content = getSlotContent(position);
          const isMenu = content.type === 'menu';
          const isSound = content.type === 'sound';
          const isPlaylist = content.type === 'playlist';
          const isEmpty = content.type === 'empty';

          return (
            <div
              key={position}
              className={`bg-gray-800 rounded-lg p-4 flex items-center justify-between transition-all ${
                isEmpty ? 'bg-gray-800/50 border border-dashed border-gray-700' : ''
              }`}
            >
              <div className="flex items-center gap-4">
                {/* Slot number */}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-lg ${
                  isEmpty ? 'bg-gray-700 text-gray-500' : 'bg-orange-600'
                }`}>
                  {position}
                </div>

                {/* Content display */}
                {isEmpty ? (
                  <span className="text-gray-500">Empty slot</span>
                ) : isSound ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xl">🔊</span>
                    <div>
                      {/* Inline rename for sounds */}
                      {(() => {
                        const item = content.item as SoundMenuItem;
                        const itemId = item.id;
                        const currentName = item.displayName || item.soundAlias || 'Sound';
                        const isRenaming = renamingItemId === itemId && (renamingItemType === 'root-item' || renamingItemType === 'menu-item');

                        if (isRenaming) {
                          return (
                            <input
                              type="text"
                              value={renamingItemName}
                              onChange={(e) => setRenamingItemName(e.target.value.slice(0, 32))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && renamingItemName.trim()) {
                                  if (currentParentId === null) {
                                    renameRootItemMutation.mutate({ itemId, displayName: renamingItemName.trim() });
                                  } else {
                                    renameMenuItemMutation.mutate({ menuId: currentParentId, itemId, displayName: renamingItemName.trim() });
                                  }
                                } else if (e.key === 'Escape') {
                                  setRenamingItemId(null);
                                  setRenamingItemType(null);
                                  setRenamingItemName('');
                                }
                              }}
                              onBlur={() => {
                                if (renamingItemName.trim() && renamingItemName !== currentName) {
                                  if (currentParentId === null) {
                                    renameRootItemMutation.mutate({ itemId, displayName: renamingItemName.trim() });
                                  } else {
                                    renameMenuItemMutation.mutate({ menuId: currentParentId, itemId, displayName: renamingItemName.trim() });
                                  }
                                } else {
                                  setRenamingItemId(null);
                                  setRenamingItemType(null);
                                  setRenamingItemName('');
                                }
                              }}
                              className="bg-gray-700 border border-orange-500 rounded px-2 py-0.5 text-orange-300 font-medium focus:outline-none w-40"
                              autoFocus
                            />
                          );
                        }
                        return (
                          <button
                            onClick={() => {
                              setRenamingItemId(itemId);
                              setRenamingItemType(currentParentId === null ? 'root-item' : 'menu-item');
                              setRenamingItemName(currentName);
                            }}
                            className="font-medium text-orange-300 hover:text-orange-200 hover:underline cursor-pointer text-left"
                            title="Click to rename"
                          >
                            {currentName}
                          </button>
                        );
                      })()}
                      <div className="text-xs text-gray-500">Sound • {formatDuration((content.item as SoundMenuItem).durationSeconds)}</div>
                    </div>
                  </div>
                ) : isPlaylist ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xl">📋</span>
                    <div>
                      {/* Inline rename for playlists */}
                      {(() => {
                        const item = content.item as SoundMenuItem;
                        const itemId = item.id;
                        const currentName = item.displayName || item.playlistName || 'Playlist';
                        const isRenaming = renamingItemId === itemId && (renamingItemType === 'root-item' || renamingItemType === 'menu-item');

                        if (isRenaming) {
                          return (
                            <input
                              type="text"
                              value={renamingItemName}
                              onChange={(e) => setRenamingItemName(e.target.value.slice(0, 32))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && renamingItemName.trim()) {
                                  if (currentParentId === null) {
                                    renameRootItemMutation.mutate({ itemId, displayName: renamingItemName.trim() });
                                  } else {
                                    renameMenuItemMutation.mutate({ menuId: currentParentId, itemId, displayName: renamingItemName.trim() });
                                  }
                                } else if (e.key === 'Escape') {
                                  setRenamingItemId(null);
                                  setRenamingItemType(null);
                                  setRenamingItemName('');
                                }
                              }}
                              onBlur={() => {
                                if (renamingItemName.trim() && renamingItemName !== currentName) {
                                  if (currentParentId === null) {
                                    renameRootItemMutation.mutate({ itemId, displayName: renamingItemName.trim() });
                                  } else {
                                    renameMenuItemMutation.mutate({ menuId: currentParentId, itemId, displayName: renamingItemName.trim() });
                                  }
                                } else {
                                  setRenamingItemId(null);
                                  setRenamingItemType(null);
                                  setRenamingItemName('');
                                }
                              }}
                              className="bg-gray-700 border border-blue-500 rounded px-2 py-0.5 text-blue-300 font-medium focus:outline-none w-40"
                              autoFocus
                            />
                          );
                        }
                        return (
                          <button
                            onClick={() => {
                              setRenamingItemId(itemId);
                              setRenamingItemType(currentParentId === null ? 'root-item' : 'menu-item');
                              setRenamingItemName(currentName);
                            }}
                            className="font-medium text-blue-300 hover:text-blue-200 hover:underline cursor-pointer text-left"
                            title="Click to rename"
                          >
                            {currentName}
                          </button>
                        );
                      })()}
                      <div className="text-xs text-gray-500">
                        Playlist • {(content.item as SoundMenuItem).playlistSoundCount || 0} sounds
                      </div>
                    </div>
                  </div>
                ) : isMenu ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xl">📁</span>
                    <div>
                      {/* Inline rename for menus */}
                      {(() => {
                        const item = content.item as SoundMenuItem;
                        const menuId = item.nestedMenuId;
                        const currentName = item.displayName || item.menuName || 'Menu';
                        const isRenaming = renamingItemId === menuId && renamingItemType === 'menu';

                        if (isRenaming && menuId) {
                          return (
                            <input
                              type="text"
                              value={renamingItemName}
                              onChange={(e) => setRenamingItemName(e.target.value.slice(0, 32))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && renamingItemName.trim()) {
                                  renameMenuMutation.mutate({ menuId, menuName: renamingItemName.trim() });
                                } else if (e.key === 'Escape') {
                                  setRenamingItemId(null);
                                  setRenamingItemType(null);
                                  setRenamingItemName('');
                                }
                              }}
                              onBlur={() => {
                                if (renamingItemName.trim() && renamingItemName !== currentName) {
                                  renameMenuMutation.mutate({ menuId, menuName: renamingItemName.trim() });
                                } else {
                                  setRenamingItemId(null);
                                  setRenamingItemType(null);
                                  setRenamingItemName('');
                                }
                              }}
                              className="bg-gray-700 border border-cyan-500 rounded px-2 py-0.5 text-cyan-300 font-medium focus:outline-none w-40"
                              autoFocus
                            />
                          );
                        }
                        return (
                          <button
                            onClick={() => {
                              if (menuId) {
                                setRenamingItemId(menuId);
                                setRenamingItemType('menu');
                                setRenamingItemName(currentName);
                              }
                            }}
                            className="font-medium text-cyan-300 hover:text-cyan-200 hover:underline cursor-pointer text-left"
                            title="Click to rename"
                          >
                            {currentName}
                          </button>
                        );
                      })()}
                      <div className="text-xs text-gray-500">
                        Menu • {(content.item as SoundMenuItem).menuItemCount || 0} items
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2">
                {/* Up/Down arrows for non-empty slots */}
                {!isEmpty && (
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => swapPositionsMutation.mutate({ fromPos: position, toPos: position - 1 })}
                      disabled={position === 1 || swapPositionsMutation.isPending}
                      className="px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded text-xs transition-colors"
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => swapPositionsMutation.mutate({ fromPos: position, toPos: position + 1 })}
                      disabled={position === 9 || swapPositionsMutation.isPending}
                      className="px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 rounded text-xs transition-colors"
                      title="Move down"
                    >
                      ▼
                    </button>
                  </div>
                )}
                {isMenu && (
                  <button
                    onClick={() => navigateToMenu(content.item!)}
                    className="px-3 py-1.5 bg-cyan-600/30 hover:bg-cyan-600/50 text-cyan-300 rounded text-sm transition-colors"
                    title="Navigate into this menu"
                  >
                    Enter →
                  </button>
                )}
                <button
                  onClick={() => openEditSlot(position)}
                  className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
                >
                  {isEmpty ? 'Assign' : 'Edit'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* In-Game Preview */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="font-medium mb-3">In-Game Preview</h3>
        <div className="inline-block bg-black/80 rounded-lg border border-gray-600 p-3 font-mono text-sm">
          <div className="text-orange-400 mb-2 border-b border-gray-600 pb-1">
            ♪ {menuPath.length > 1 ? menuPath[menuPath.length - 1].name : 'Sound Menu'}
          </div>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((pos) => {
            const content = getSlotContent(pos);
            if (content.type === 'empty') return null;
            const name = content.item && ('menuName' in content.item ? content.item.menuName : content.item.displayName);
            const isMenuType = content.type === 'menu';
            return (
              <div key={pos} className="flex items-center gap-2 py-0.5">
                <span className="text-yellow-400">{pos}.</span>
                <span className={isMenuType ? 'text-cyan-400' : 'text-white'}>{name}</span>
                {isMenuType && <span className="text-gray-400 ml-auto">→</span>}
              </div>
            );
          })}
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].every(p => getSlotContent(p).type === 'empty') && (
            <div className="text-gray-500 italic">No items configured</div>
          )}
          <div className="text-gray-500 text-xs mt-2 border-t border-gray-600 pt-1">
            1-9 select, 0 next page, BKSP back
          </div>
        </div>
      </div>

      {/* Edit Slot Dialog */}
      {editingSlot !== null && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-4">
              Slot {editingSlot} - {menuPath.length > 1 ? menuPath[menuPath.length - 1].name : 'Root'}
            </h3>

            {error && (
              <div className="bg-red-900/30 border border-red-600 rounded-lg p-3 mb-4">
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            {/* View mode - show current assignment */}
            {editMode === 'view' && editingSlotItem && (
              <div className="space-y-4">
                <div className="bg-gray-900 rounded-lg p-4">
                  {(() => {
                    // Determine item type - SoundMenuItem has itemType, SoundMenu has menuName
                    const isSoundMenu = 'menuName' in editingSlotItem && !('itemType' in editingSlotItem);

                    if (isSoundMenu) {
                      // It's a SoundMenu object
                      const menu = editingSlotItem as SoundMenu;
                      if (menu.playlistId) {
                        return (
                          <div className="flex items-center gap-3">
                            <span className="text-3xl">📋</span>
                            <div className="flex-1">
                              <div className="text-blue-300 font-medium">{menu.menuName}</div>
                              <div className="text-sm text-gray-500">Playlist • {menu.itemCount || 0} sounds</div>
                            </div>
                          </div>
                        );
                      } else {
                        return (
                          <div className="flex items-center gap-3">
                            <span className="text-3xl">📁</span>
                            <div className="flex-1">
                              <div className="text-cyan-300 font-medium">{menu.menuName}</div>
                              <div className="text-sm text-gray-500">Menu • {menu.itemCount || 0} items</div>
                            </div>
                          </div>
                        );
                      }
                    } else {
                      // It's a SoundMenuItem object (from root-items or menu items)
                      const item = editingSlotItem as SoundMenuItem;
                      const itemType = item.itemType || 'sound';

                      // Get display name with proper fallbacks
                      const displayName = item.displayName
                        || item.soundAlias
                        || item.playlistName
                        || item.menuName  // For nested menus
                        || 'Unknown';

                      // Get count for playlists/menus
                      const playlistCount = item.playlistSoundCount || 0;
                      const menuCount = item.menuItemCount || 0;

                      return (
                        <div className="flex items-center gap-3">
                          <span className="text-3xl">
                            {itemType === 'sound' ? '🔊' : itemType === 'playlist' ? '📋' : '📁'}
                          </span>
                          <div className="flex-1">
                            <div className={`font-medium ${
                              itemType === 'sound' ? 'text-orange-300' :
                              itemType === 'playlist' ? 'text-blue-300' : 'text-cyan-300'
                            }`}>
                              {displayName}
                            </div>
                            <div className="text-sm text-gray-500">
                              {itemType === 'sound' && `Sound • ${formatDuration(item.durationSeconds)}`}
                              {itemType === 'playlist' && `Playlist • ${playlistCount} sounds`}
                              {itemType === 'menu' && `Menu • ${menuCount} items`}
                            </div>
                          </div>
                        </div>
                      );
                    }
                  })()}
                </div>

                {/* Edit playlist sounds button - only for playlist items at root level */}
                {(() => {
                  const item = editingSlotItem as SoundMenuItem;
                  if (item?.itemType === 'playlist' && currentParentId === null) {
                    return (
                      <button
                        onClick={() => {
                          // Load snapshot items into editing state
                          if (item.playlistSnapshot?.items) {
                            setEditingSnapshotItems([...item.playlistSnapshot.items]);
                          } else {
                            setEditingSnapshotItems([]);
                          }
                          setEditMode('edit-playlist-sounds');
                        }}
                        className="w-full px-4 py-2 bg-purple-600/30 hover:bg-purple-600/50 text-purple-300 rounded transition-colors mb-3 flex items-center justify-center gap-2"
                      >
                        ✏️ Edit Sound Names
                      </button>
                    );
                  }
                  return null;
                })()}

                <div className="flex gap-2">
                  <button
                    onClick={() => setEditMode('pick-type')}
                    className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                  >
                    Change
                  </button>
                  {currentParentId === null ? (
                    // At root level - remove root item (and delete menu if it's a menu type)
                    <button
                      onClick={async () => {
                        const item = editingSlotItem as SoundMenuItem;
                        if (item.itemType === 'menu' && item.nestedMenuId) {
                          if (confirm('Delete this menu and all its contents?')) {
                            // First remove the root item, then delete the menu
                            if (isServerMode) {
                              await sounds.removeServerRootItem(item.id);
                              await sounds.deleteServerMenu(item.nestedMenuId);
                            } else {
                              await sounds.removeRootItem(item.id);
                              await sounds.deleteMenu(item.nestedMenuId);
                            }
                            queryClient.invalidateQueries({ queryKey });
                            queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
                            closeEditSlot();
                          }
                        } else {
                          // Just remove the root item (sound or playlist)
                          if (isServerMode) {
                            await sounds.removeServerRootItem(item.id);
                          } else {
                            await sounds.removeRootItem(item.id);
                          }
                          queryClient.invalidateQueries({ queryKey });
                          queryClient.invalidateQueries({ queryKey: [...queryKey, 'rootItems'] });
                          closeEditSlot();
                        }
                      }}
                      className="flex-1 px-4 py-2 bg-red-600/30 hover:bg-red-600/50 text-red-300 rounded transition-colors"
                    >
                      {(editingSlotItem as SoundMenuItem)?.itemType === 'menu' ? 'Delete' : 'Remove'}
                    </button>
                  ) : (
                    // Inside a menu - just remove the item
                    <button
                      onClick={() => {
                        if (currentParentId !== null) {
                          removeItemMutation.mutate({ menuId: currentParentId, itemId: editingSlotItem!.id });
                        }
                      }}
                      className="flex-1 px-4 py-2 bg-red-600/30 hover:bg-red-600/50 text-red-300 rounded transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Pick type mode */}
            {editMode === 'pick-type' && (
              <div className="space-y-3">
                <p className="text-sm text-gray-400 mb-4">What do you want to assign to this slot?</p>
                <button
                  onClick={() => { setEditMode('pick-sound'); setSearchQuery(''); }}
                  className="w-full p-4 bg-orange-600/20 hover:bg-orange-600/30 border border-orange-500/50 rounded-lg text-left flex items-center gap-3 transition-colors"
                >
                  <span className="text-2xl">🔊</span>
                  <div>
                    <div className="font-medium text-orange-300">Sound</div>
                    <div className="text-sm text-gray-400">Play a single sound</div>
                  </div>
                </button>
                <button
                  onClick={() => { setEditMode('pick-playlist'); setSearchQuery(''); }}
                  className="w-full p-4 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/50 rounded-lg text-left flex items-center gap-3 transition-colors"
                >
                  <span className="text-2xl">📋</span>
                  <div>
                    <div className="font-medium text-blue-300">Playlist</div>
                    <div className="text-sm text-gray-400">Cycle through playlist sounds</div>
                  </div>
                </button>
                <button
                  onClick={() => { setEditMode('pick-menu'); setSearchQuery(''); }}
                  className="w-full p-4 bg-cyan-600/20 hover:bg-cyan-600/30 border border-cyan-500/50 rounded-lg text-left flex items-center gap-3 transition-colors"
                >
                  <span className="text-2xl">📁</span>
                  <div>
                    <div className="font-medium text-cyan-300">Menu</div>
                    <div className="text-sm text-gray-400">Navigate into a sub-menu</div>
                  </div>
                </button>
              </div>
            )}

            {/* Pick sound mode */}
            {editMode === 'pick-sound' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setEditMode('pick-type')}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    ← Back
                  </button>
                  <span className="text-sm text-gray-400">Select a sound</span>
                </div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search sounds..."
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500"
                  autoFocus
                />
                <div className="max-h-60 overflow-y-auto space-y-1">
                  {filteredSounds.slice(0, 30).map((sound) => (
                    <button
                      key={sound.id}
                      onClick={() => {
                        addSoundMutation.mutate({
                          soundId: sound.id,
                          soundAlias: sound.alias,
                          position: editingSlot!,
                          existingItem: editingSlotItem,
                        });
                      }}
                      className="w-full text-left px-3 py-2 rounded hover:bg-gray-700 flex items-center justify-between"
                    >
                      <span>🔊 {sound.alias}</span>
                      <span className="text-xs text-gray-500">{formatDuration(sound.durationSeconds)}</span>
                    </button>
                  ))}
                  {filteredSounds.length === 0 && (
                    <div className="text-gray-500 text-center py-4">No sounds found</div>
                  )}
                </div>
              </div>
            )}

            {/* Pick playlist mode */}
            {editMode === 'pick-playlist' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setEditMode('pick-type')}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    ← Back
                  </button>
                  <span className="text-sm text-gray-400">Select a playlist</span>
                </div>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search playlists..."
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
                  autoFocus
                />
                <div className="max-h-60 overflow-y-auto space-y-1">
                  {filteredPlaylists.slice(0, 30).map((playlist) => (
                    <button
                      key={playlist.id}
                      onClick={() => {
                        addPlaylistMutation.mutate({
                          playlistId: playlist.id,
                          playlistName: playlist.name,
                          position: editingSlot!,
                          existingItem: editingSlotItem,
                        });
                      }}
                      className="w-full text-left px-3 py-2 rounded hover:bg-gray-700 flex items-center justify-between"
                    >
                      <span>📋 {playlist.name}</span>
                      <span className="text-xs text-gray-500">{playlist.soundCount || 0} sounds</span>
                    </button>
                  ))}
                  {filteredPlaylists.length === 0 && (
                    <div className="text-gray-500 text-center py-4">No playlists found</div>
                  )}
                </div>
              </div>
            )}

            {/* Create menu mode (simplified - no menu picker, just create) */}
            {(editMode === 'pick-menu' || editMode === 'create-menu') && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => setEditMode('pick-type')}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    ← Back
                  </button>
                  <span className="text-sm text-gray-400">Create new menu</span>
                </div>
                <p className="text-sm text-gray-400">
                  Enter a name for the new menu. You can add sounds and playlists to it after creating.
                </p>
                <input
                  type="text"
                  value={newMenuName}
                  onChange={(e) => setNewMenuName(e.target.value.slice(0, 32))}
                  placeholder="Menu name (e.g., Taunts, Music)"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500"
                  autoFocus
                />
                <button
                  onClick={() => {
                    if (!newMenuName.trim()) {
                      setError('Menu name is required');
                      return;
                    }
                    createMenuMutation.mutate({
                      name: newMenuName,
                      position: editingSlot!,
                      parentId: currentParentId,
                      existingItem: editingSlotItem,
                    });
                  }}
                  disabled={!newMenuName.trim() || createMenuMutation.isPending}
                  className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                >
                  {createMenuMutation.isPending ? 'Creating...' : 'Create Menu'}
                </button>
              </div>
            )}

            {/* Edit playlist sounds mode - customize display names for each sound in the playlist */}
            {editMode === 'edit-playlist-sounds' && editingSlotItem && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => {
                      setEditMode('view');
                      setEditingSnapshotItems([]);
                    }}
                    className="text-sm text-gray-400 hover:text-white"
                  >
                    ← Back
                  </button>
                  <span className="text-sm text-gray-400">Edit Sound Names</span>
                </div>

                <p className="text-sm text-gray-400">
                  Customize how each sound appears in-game. Leave blank to use the original name.
                </p>

                {/* Refresh button */}
                <button
                  onClick={() => {
                    const item = editingSlotItem as SoundMenuItem;
                    refreshSnapshotMutation.mutate(item.id);
                  }}
                  disabled={refreshSnapshotMutation.isPending}
                  className="w-full px-3 py-2 bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 rounded text-sm transition-colors flex items-center justify-center gap-2"
                >
                  {refreshSnapshotMutation.isPending ? (
                    <>Refreshing...</>
                  ) : (
                    <>🔄 Refresh from Live Playlist</>
                  )}
                </button>

                {/* Snapshot info */}
                {(() => {
                  const item = editingSlotItem as SoundMenuItem;
                  const snapshot = item.playlistSnapshot;
                  if (snapshot) {
                    const capturedDate = new Date(snapshot.capturedAt);
                    return (
                      <div className="text-xs text-gray-500 text-center">
                        Snapshot from {capturedDate.toLocaleDateString()} at {capturedDate.toLocaleTimeString()}
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Sound list */}
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {editingSnapshotItems.length === 0 ? (
                    <div className="text-gray-500 text-center py-4">
                      No snapshot data. Click "Refresh from Live Playlist" to create one.
                    </div>
                  ) : (
                    editingSnapshotItems.map((snapItem, index) => (
                      <div key={snapItem.position} className="bg-gray-900 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-yellow-400 font-bold">{snapItem.position}.</span>
                          <span className="text-gray-400 text-sm">🔊 {snapItem.originalAlias}</span>
                        </div>
                        <input
                          type="text"
                          value={snapItem.displayName || ''}
                          onChange={(e) => {
                            const newItems = [...editingSnapshotItems];
                            newItems[index] = {
                              ...newItems[index],
                              displayName: e.target.value || null,
                            };
                            setEditingSnapshotItems(newItems);
                          }}
                          placeholder={snapItem.originalAlias}
                          className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 text-sm"
                        />
                      </div>
                    ))
                  )}
                </div>

                {/* Save button */}
                {editingSnapshotItems.length > 0 && (
                  <button
                    onClick={() => {
                      const item = editingSlotItem as SoundMenuItem;
                      const updates = editingSnapshotItems.map(snapItem => ({
                        position: snapItem.position,
                        displayName: snapItem.displayName,
                      }));
                      updateSnapshotMutation.mutate({ itemId: item.id, items: updates });
                    }}
                    disabled={updateSnapshotMutation.isPending}
                    className="w-full px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
                  >
                    {updateSnapshotMutation.isPending ? 'Saving...' : 'Save Custom Names'}
                  </button>
                )}
              </div>
            )}

            {/* Close button */}
            <div className="mt-6 pt-4 border-t border-gray-700">
              <button
                onClick={closeEditSlot}
                className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                {editMode === 'view' ? 'Done' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
