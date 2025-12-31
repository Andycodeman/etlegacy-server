import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sounds } from '../api/client';
import type { SoundMenu, SoundMenuItem, UserSound } from '../api/client';

interface SoundMenuEditorProps {
  userSounds: UserSound[];
}

function formatDuration(seconds?: number): string {
  if (!seconds) return '-';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// DnD types
interface DragItem {
  id: number;
  index: number;
}

export default function SoundMenuEditor({ userSounds }: SoundMenuEditorProps) {
  const queryClient = useQueryClient();

  // State
  const [editingMenu, setEditingMenu] = useState<SoundMenu | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [error, setError] = useState('');

  // Form state for create/edit dialog
  const [menuName, setMenuName] = useState('');
  const [menuPosition, setMenuPosition] = useState(1);
  const [menuType, setMenuType] = useState<'manual' | 'playlist'>('manual');
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<number | null>(null);

  // Items for manual menu editing
  const [menuItems, setMenuItems] = useState<SoundMenuItem[]>([]);
  const [isPlaylistBacked, setIsPlaylistBacked] = useState(false);

  // Add sound state
  const [addingSoundPosition, setAddingSoundPosition] = useState<number | null>(null);
  const [soundSearchQuery, setSoundSearchQuery] = useState('');

  // Drag and drop state
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Fetch menus
  const { data: menusData, isLoading: menusLoading } = useQuery({
    queryKey: ['soundMenus'],
    queryFn: sounds.listMenus,
  });

  // Fetch playlists for dropdown
  const { data: playlistsData } = useQuery({
    queryKey: ['playlists'],
    queryFn: sounds.playlists,
  });

  const menus = menusData?.menus || [];
  const playlists = playlistsData?.playlists || [];

  // Get available positions (1-9 minus already taken)
  const getAvailablePositions = useCallback((excludeMenuId?: number) => {
    const taken = new Set(
      menus
        .filter((m) => m.id !== excludeMenuId)
        .map((m) => m.menuPosition)
    );
    return [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((p) => !taken.has(p));
  }, [menus]);

  // Mutations
  const createMenuMutation = useMutation({
    mutationFn: () =>
      sounds.createMenu(
        menuName,
        menuPosition,
        menuType === 'playlist' ? selectedPlaylistId : null
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['soundMenus'] });
      closeDialog();
    },
    onError: (err: Error) => setError(err.message),
  });

  const updateMenuMutation = useMutation({
    mutationFn: (menuId: number) =>
      sounds.updateMenu(menuId, {
        menuName,
        menuPosition,
        playlistId: menuType === 'playlist' ? selectedPlaylistId : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['soundMenus'] });
      closeDialog();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMenuMutation = useMutation({
    mutationFn: (menuId: number) => sounds.deleteMenu(menuId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['soundMenus'] });
      setDeleteConfirm(null);
    },
    onError: (err: Error) => {
      setError(err.message);
      setDeleteConfirm(null);
    },
  });

  const addItemMutation = useMutation({
    mutationFn: ({ menuId, soundAlias, position }: { menuId: number; soundAlias: string; position: number }) =>
      sounds.addMenuItem(menuId, soundAlias, position),
    onSuccess: () => {
      if (editingMenu) {
        fetchMenuItems(editingMenu.id);
      }
      setAddingSoundPosition(null);
      setSoundSearchQuery('');
    },
    onError: (err: Error) => setError(err.message),
  });

  const removeItemMutation = useMutation({
    mutationFn: ({ menuId, itemId }: { menuId: number; itemId: number }) =>
      sounds.removeMenuItem(menuId, itemId),
    onSuccess: () => {
      if (editingMenu) {
        fetchMenuItems(editingMenu.id);
      }
    },
    onError: (err: Error) => setError(err.message),
  });

  const reorderItemsMutation = useMutation({
    mutationFn: ({ menuId, itemIds }: { menuId: number; itemIds: number[] }) =>
      sounds.reorderMenuItems(menuId, itemIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['soundMenus'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  // Fetch menu items when editing
  const fetchMenuItems = async (menuId: number) => {
    try {
      const data = await sounds.getMenu(menuId);
      setMenuItems(data.items);
      setIsPlaylistBacked(data.isPlaylistBacked);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Dialog handlers
  const openCreateDialog = () => {
    const available = getAvailablePositions();
    if (available.length === 0) {
      setError('All 9 menu positions are in use. Delete a menu to create a new one.');
      return;
    }
    setIsCreating(true);
    setEditingMenu(null);
    setMenuName('');
    setMenuPosition(available[0]);
    setMenuType('manual');
    setSelectedPlaylistId(null);
    setMenuItems([]);
    setIsPlaylistBacked(false);
    setError('');
  };

  const openEditDialog = async (menu: SoundMenu) => {
    setIsCreating(false);
    setEditingMenu(menu);
    setMenuName(menu.menuName);
    setMenuPosition(menu.menuPosition);
    setMenuType(menu.playlistId ? 'playlist' : 'manual');
    setSelectedPlaylistId(menu.playlistId);
    setError('');
    await fetchMenuItems(menu.id);
  };

  const closeDialog = () => {
    setIsCreating(false);
    setEditingMenu(null);
    setMenuName('');
    setMenuType('manual');
    setSelectedPlaylistId(null);
    setMenuItems([]);
    setIsPlaylistBacked(false);
    setError('');
    setAddingSoundPosition(null);
  };

  const handleSave = () => {
    if (!menuName.trim()) {
      setError('Menu name is required');
      return;
    }
    if (menuType === 'playlist' && !selectedPlaylistId) {
      setError('Please select a playlist');
      return;
    }

    if (isCreating) {
      createMenuMutation.mutate();
    } else if (editingMenu) {
      updateMenuMutation.mutate(editingMenu.id);
    }
  };

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, item: SoundMenuItem, index: number) => {
    setDraggedItem({ id: item.id, index });
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedItem && draggedItem.index !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (!draggedItem || !editingMenu) return;

    const newItems = [...menuItems];
    const [movedItem] = newItems.splice(draggedItem.index, 1);
    newItems.splice(targetIndex, 0, movedItem);

    setMenuItems(newItems);
    setDraggedItem(null);
    setDragOverIndex(null);

    // Save new order
    const itemIds = newItems.map((item) => item.id);
    reorderItemsMutation.mutate({ menuId: editingMenu.id, itemIds });
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDragOverIndex(null);
  };

  // Filter sounds for adding
  const filteredSounds = userSounds.filter((s) =>
    s.alias.toLowerCase().includes(soundSearchQuery.toLowerCase())
  );

  // Get next available position in menu
  const getNextItemPosition = () => {
    const usedPositions = new Set(menuItems.map((item) => item.itemPosition));
    for (let i = 1; i <= 9; i++) {
      if (!usedPositions.has(i)) return i;
    }
    return null;
  };

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
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Sound Menus</h2>
          <p className="text-sm text-gray-400">
            Configure in-game sound menus (press the menu key to access)
          </p>
        </div>
        <button
          onClick={openCreateDialog}
          className="px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors flex items-center gap-2"
        >
          <span>+</span> New Menu
        </button>
      </div>

      {error && !editingMenu && !isCreating && (
        <div className="bg-red-900/30 border border-red-600 rounded-lg p-4">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {/* Menu List */}
      <div className="grid gap-4">
        {/* Show all 9 positions */}
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((position) => {
          const menu = menus.find((m) => m.menuPosition === position);

          if (menu) {
            return (
              <div
                key={position}
                className="bg-gray-800 rounded-lg p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center font-bold text-lg">
                    {position}
                  </div>
                  <div>
                    <div className="font-medium">{menu.menuName}</div>
                    <div className="text-sm text-gray-400">
                      {menu.playlistId ? (
                        <span className="text-blue-400">
                          Playlist: {menu.playlistName} ({menu.itemCount} sounds)
                        </span>
                      ) : (
                        <span>Manual: {menu.itemCount} sound{menu.itemCount !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openEditDialog(menu)}
                    className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
                  >
                    Edit
                  </button>
                  {deleteConfirm === menu.id ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => deleteMenuMutation.mutate(menu.id)}
                        disabled={deleteMenuMutation.isPending}
                        className="px-2 py-1 bg-red-600 hover:bg-red-500 rounded text-xs"
                      >
                        Yes
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        className="px-2 py-1 bg-gray-600 hover:bg-gray-500 rounded text-xs"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirm(menu.id)}
                      className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded text-sm transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          }

          // Empty position
          return (
            <div
              key={position}
              className="bg-gray-800/50 border border-dashed border-gray-700 rounded-lg p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-gray-700 rounded-lg flex items-center justify-center font-bold text-lg text-gray-500">
                  {position}
                </div>
                <span className="text-gray-500">Empty slot</span>
              </div>
              <button
                onClick={() => {
                  openCreateDialog();
                  setMenuPosition(position);
                }}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
              >
                + Add Menu
              </button>
            </div>
          );
        })}
      </div>

      {/* Menu Preview */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="font-medium mb-3">In-Game Preview</h3>
        <div className="inline-block bg-black/80 rounded-lg border border-gray-600 p-3 font-mono text-sm">
          <div className="text-orange-400 mb-2 border-b border-gray-600 pb-1">
            ♪ Sound Menu
          </div>
          {menus.length === 0 ? (
            <div className="text-gray-500 italic">No menus configured</div>
          ) : (
            menus
              .sort((a, b) => a.menuPosition - b.menuPosition)
              .map((menu) => (
                <div key={menu.id} className="flex items-center gap-2 py-0.5">
                  <span className="text-yellow-400">{menu.menuPosition}.</span>
                  <span className="text-white">{menu.menuName}</span>
                  <span className="text-gray-400 ml-auto">→</span>
                </div>
              ))
          )}
          <div className="text-gray-500 text-xs mt-2 border-t border-gray-600 pt-1">
            1-9 select, ESC close
          </div>
        </div>
      </div>

      {/* Create/Edit Dialog */}
      {(isCreating || editingMenu) && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-gray-800 rounded-lg p-6 max-w-2xl w-full my-8">
            <h3 className="text-lg font-semibold mb-4">
              {isCreating ? 'Create New Menu' : `Edit Menu: ${editingMenu?.menuName}`}
            </h3>

            <div className="space-y-4">
              {/* Menu Name */}
              <div>
                <label className="block text-sm text-gray-400 mb-1">Menu Name</label>
                <input
                  type="text"
                  value={menuName}
                  onChange={(e) => setMenuName(e.target.value.slice(0, 32))}
                  placeholder="e.g., Taunts, Music, Memes"
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500"
                />
              </div>

              {/* Position */}
              <div>
                <label className="block text-sm text-gray-400 mb-1">Position (1-9)</label>
                <select
                  value={menuPosition}
                  onChange={(e) => setMenuPosition(parseInt(e.target.value))}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white focus:outline-none focus:border-orange-500"
                >
                  {getAvailablePositions(editingMenu?.id).map((pos) => (
                    <option key={pos} value={pos}>
                      Position {pos}
                    </option>
                  ))}
                  {editingMenu && (
                    <option value={editingMenu.menuPosition}>
                      Position {editingMenu.menuPosition} (current)
                    </option>
                  )}
                </select>
              </div>

              {/* Menu Type */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">Menu Type</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="menuType"
                      checked={menuType === 'manual'}
                      onChange={() => setMenuType('manual')}
                      className="text-orange-500 focus:ring-orange-500"
                    />
                    <span>Manual - Pick individual sounds</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="menuType"
                      checked={menuType === 'playlist'}
                      onChange={() => setMenuType('playlist')}
                      className="text-orange-500 focus:ring-orange-500"
                    />
                    <span>Playlist - Use sounds from playlist</span>
                  </label>
                </div>
              </div>

              {/* Playlist Selector (for playlist type) */}
              {menuType === 'playlist' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Select Playlist</label>
                  <select
                    value={selectedPlaylistId || ''}
                    onChange={(e) => setSelectedPlaylistId(e.target.value ? parseInt(e.target.value) : null)}
                    className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white focus:outline-none focus:border-orange-500"
                  >
                    <option value="">Choose a playlist...</option>
                    {playlists.map((playlist) => (
                      <option key={playlist.id} value={playlist.id}>
                        {playlist.name} ({playlist.soundCount || 0} sounds)
                        {playlist.isPublic ? ' [Public]' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    First 9 sounds from the playlist will appear in the menu
                  </p>
                </div>
              )}

              {/* Manual Items (for manual type or viewing playlist items) */}
              {(menuType === 'manual' || isPlaylistBacked) && editingMenu && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm text-gray-400">
                      Menu Items {isPlaylistBacked && <span className="text-blue-400">(from playlist)</span>}
                    </label>
                    {!isPlaylistBacked && menuItems.length < 9 && (
                      <button
                        onClick={() => setAddingSoundPosition(getNextItemPosition())}
                        className="text-sm text-orange-400 hover:text-orange-300"
                      >
                        + Add Sound
                      </button>
                    )}
                  </div>

                  {/* Items list with drag-drop */}
                  <div className="space-y-1 bg-gray-900 rounded-lg p-2">
                    {menuItems.length === 0 ? (
                      <div className="text-gray-500 text-center py-4">
                        No sounds added yet
                      </div>
                    ) : (
                      menuItems.map((item, index) => (
                        <div
                          key={item.id}
                          draggable={!isPlaylistBacked}
                          onDragStart={(e) => handleDragStart(e, item, index)}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, index)}
                          onDragEnd={handleDragEnd}
                          className={`flex items-center gap-2 p-2 rounded transition-colors ${
                            dragOverIndex === index
                              ? 'bg-orange-600/30 border-2 border-orange-500'
                              : 'bg-gray-800 hover:bg-gray-700'
                          } ${!isPlaylistBacked ? 'cursor-grab active:cursor-grabbing' : ''}`}
                        >
                          {!isPlaylistBacked && (
                            <span className="text-gray-500 text-xs">⋮⋮</span>
                          )}
                          <span className="w-6 text-center font-bold text-orange-400">
                            {index + 1}
                          </span>
                          <span className="flex-1">{item.displayName}</span>
                          <span className="text-xs text-gray-500">
                            {formatDuration(item.durationSeconds)}
                          </span>
                          {!isPlaylistBacked && (
                            <button
                              onClick={() =>
                                editingMenu &&
                                removeItemMutation.mutate({ menuId: editingMenu.id, itemId: item.id })
                              }
                              className="text-red-400 hover:text-red-300 text-xs"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>

                  {/* Add sound picker */}
                  {addingSoundPosition !== null && !isPlaylistBacked && (
                    <div className="mt-2 bg-gray-700 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm text-gray-400">Add sound at position {menuItems.length + 1}:</span>
                        <button
                          onClick={() => setAddingSoundPosition(null)}
                          className="text-gray-400 hover:text-white ml-auto"
                        >
                          ✕
                        </button>
                      </div>
                      <input
                        type="text"
                        value={soundSearchQuery}
                        onChange={(e) => setSoundSearchQuery(e.target.value)}
                        placeholder="Search your sounds..."
                        className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-orange-500 mb-2"
                        autoFocus
                      />
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {filteredSounds.slice(0, 20).map((sound) => (
                          <button
                            key={sound.id}
                            onClick={() => {
                              if (editingMenu && addingSoundPosition !== null) {
                                addItemMutation.mutate({
                                  menuId: editingMenu.id,
                                  soundAlias: sound.alias,
                                  position: addingSoundPosition,
                                });
                              }
                            }}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-600 flex items-center justify-between"
                          >
                            <span>{sound.alias}</span>
                            <span className="text-xs text-gray-500">
                              {formatDuration(sound.durationSeconds)}
                            </span>
                          </button>
                        ))}
                        {filteredSounds.length === 0 && (
                          <div className="text-gray-500 text-sm text-center py-2">
                            No sounds found
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {error && (
                <p className="text-red-400 text-sm">{error}</p>
              )}
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={closeDialog}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={createMenuMutation.isPending || updateMenuMutation.isPending}
                className="px-4 py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium transition-colors"
              >
                {createMenuMutation.isPending || updateMenuMutation.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
