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

// Add item mode
type AddItemMode = 'sound' | 'menu' | 'playlist' | null;

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

  // Items for menu editing
  const [menuItems, setMenuItems] = useState<SoundMenuItem[]>([]);

  // Add item state - can be 'sound' or 'menu'
  const [addingItemMode, setAddingItemMode] = useState<AddItemMode>(null);
  const [addingItemPosition, setAddingItemPosition] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Drag and drop state for menu items
  const [draggedItem, setDraggedItem] = useState<DragItem | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Drag and drop state for menus themselves
  const [draggedMenu, setDraggedMenu] = useState<SoundMenu | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<number | null>(null);

  // Fetch all menus (we filter locally now)
  const { data: menusData, isLoading: menusLoading } = useQuery({
    queryKey: ['soundMenus'],
    queryFn: () => sounds.listMenus(),
  });

  // Use the same data for nested menu picker
  const allMenusData = menusData;

  // Fetch playlists for dropdown
  const { data: playlistsData } = useQuery({
    queryKey: ['playlists'],
    queryFn: sounds.playlists,
  });

  const menus = menusData?.menus || [];
  const allMenus = allMenusData?.menus || [];
  const playlists = playlistsData?.playlists || [];

  // Get available positions (1-9 minus already taken, plus 0 for unassigned)
  const getAvailablePositions = useCallback((excludeMenuId?: number) => {
    const taken = new Set(
      menus
        .filter((m) => m.id !== excludeMenuId && m.parentId === null && m.menuPosition > 0)
        .map((m) => m.menuPosition)
    );
    return [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((p) => !taken.has(p));
  }, [menus]);

  // Get assigned menus (position 1-9, no parent)
  const assignedMenus = menus.filter(m => m.parentId === null && m.menuPosition > 0);

  // Get unassigned menus (position 0 or null parent with position 0)
  const unassignedMenus = menus.filter(m => m.menuPosition === 0 || m.menuPosition === null);

  // Mutations
  const createMenuMutation = useMutation({
    mutationFn: () =>
      sounds.createMenu(
        menuName,
        menuPosition,
        null, // No longer using playlist-backed menus
        null  // Always create at root level
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

  const moveMenuMutation = useMutation({
    mutationFn: ({ menuId, newPosition }: { menuId: number; newPosition: number }) =>
      sounds.updateMenu(menuId, { menuPosition: newPosition }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['soundMenus'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const addSoundItemMutation = useMutation({
    mutationFn: ({ menuId, soundAlias, position }: { menuId: number; soundAlias: string; position: number }) =>
      sounds.addMenuItem(menuId, soundAlias, position),
    onSuccess: () => {
      if (editingMenu) {
        fetchMenuItems(editingMenu.id);
      }
      setAddingItemMode(null);
      setAddingItemPosition(null);
      setSearchQuery('');
    },
    onError: (err: Error) => setError(err.message),
  });

  const addNestedMenuItemMutation = useMutation({
    mutationFn: ({ menuId, nestedMenuId, position }: { menuId: number; nestedMenuId: number; position: number }) =>
      sounds.addNestedMenuItem(menuId, nestedMenuId, position),
    onSuccess: () => {
      if (editingMenu) {
        fetchMenuItems(editingMenu.id);
      }
      setAddingItemMode(null);
      setAddingItemPosition(null);
      setSearchQuery('');
    },
    onError: (err: Error) => setError(err.message),
  });

  const addPlaylistItemMutation = useMutation({
    mutationFn: ({ menuId, playlistId, position }: { menuId: number; playlistId: number; position: number }) =>
      sounds.addPlaylistMenuItem(menuId, playlistId, position),
    onSuccess: () => {
      if (editingMenu) {
        fetchMenuItems(editingMenu.id);
      }
      setAddingItemMode(null);
      setAddingItemPosition(null);
      setSearchQuery('');
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
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Dialog handlers
  const openCreateDialog = () => {
    setIsCreating(true);
    setEditingMenu(null);
    setMenuName('');
    setMenuPosition(0); // Default to unassigned
    setMenuItems([]);
    setError('');
  };

  const openEditDialog = async (menu: SoundMenu) => {
    setIsCreating(false);
    setEditingMenu(menu);
    setMenuName(menu.menuName);
    setMenuPosition(menu.menuPosition);
    setError('');
    await fetchMenuItems(menu.id);
  };

  const closeDialog = () => {
    setIsCreating(false);
    setEditingMenu(null);
    setMenuName('');
    setMenuItems([]);
    setError('');
    setAddingItemMode(null);
    setAddingItemPosition(null);
  };

  const handleSave = () => {
    if (!menuName.trim()) {
      setError('Menu name is required');
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

  // Menu drag handlers (for reordering menus in the list)
  const handleMenuDragStart = (e: React.DragEvent, menu: SoundMenu) => {
    setDraggedMenu(menu);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleMenuDragOver = (e: React.DragEvent, position: number) => {
    e.preventDefault();
    if (draggedMenu && draggedMenu.menuPosition !== position) {
      setDragOverPosition(position);
    }
  };

  const handleMenuDragLeave = () => {
    setDragOverPosition(null);
  };

  const handleMenuDrop = (e: React.DragEvent, targetPosition: number) => {
    e.preventDefault();
    if (!draggedMenu) return;

    // Check if there's already a menu at the target position
    const existingMenu = assignedMenus.find(m => m.menuPosition === targetPosition);

    if (existingMenu) {
      // Swap positions: move existing to dragged's old position, then move dragged to target
      // First move existing menu to the dragged menu's old position
      moveMenuMutation.mutate(
        { menuId: existingMenu.id, newPosition: draggedMenu.menuPosition },
        {
          onSuccess: () => {
            // Then move dragged menu to target position
            moveMenuMutation.mutate({ menuId: draggedMenu.id, newPosition: targetPosition });
          }
        }
      );
    } else {
      // Target is empty, just move the menu there
      moveMenuMutation.mutate({ menuId: draggedMenu.id, newPosition: targetPosition });
    }

    setDraggedMenu(null);
    setDragOverPosition(null);
  };

  const handleMenuDragEnd = () => {
    setDraggedMenu(null);
    setDragOverPosition(null);
  };

  // Filter sounds/menus for adding
  const filteredSounds = userSounds.filter((s) =>
    s.alias.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Get menus available to add as nested (exclude current menu and its parents)
  const getAvailableNestedMenus = useCallback(() => {
    if (!editingMenu) return allMenus;

    // Exclude current menu and any menu that would create a cycle
    const excludeIds = new Set<number>([editingMenu.id]);

    // Also exclude menus that already contain this menu
    // For simplicity, just exclude all ancestors
    let current = editingMenu;
    while (current.parentId) {
      excludeIds.add(current.parentId);
      current = allMenus.find(m => m.id === current.parentId) as SoundMenu;
      if (!current) break;
    }

    return allMenus.filter(m =>
      !excludeIds.has(m.id) &&
      m.menuName.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [allMenus, editingMenu, searchQuery]);

  // Filter playlists for adding
  const filteredPlaylists = playlists.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
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
            Configure in-game sound menus. Click Edit to add sounds, playlists, or sub-menus.
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
          const menu = assignedMenus.find((m) => m.menuPosition === position);

          if (menu) {
            return (
              <div
                key={position}
                draggable
                onDragStart={(e) => handleMenuDragStart(e, menu)}
                onDragOver={(e) => handleMenuDragOver(e, position)}
                onDragLeave={handleMenuDragLeave}
                onDrop={(e) => handleMenuDrop(e, position)}
                onDragEnd={handleMenuDragEnd}
                className={`bg-gray-800 rounded-lg p-4 flex items-center justify-between cursor-grab active:cursor-grabbing transition-all ${
                  dragOverPosition === position ? 'ring-2 ring-orange-500 bg-orange-600/20' : ''
                } ${draggedMenu?.id === menu.id ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500 text-xs">⋮⋮</span>
                    <div className="w-8 h-8 bg-orange-600 rounded-lg flex items-center justify-center font-bold text-lg">
                      {position}
                    </div>
                  </div>
                  <div>
                    <div className="font-medium">{menu.menuName}</div>
                    <div className="text-sm text-gray-400">
                      {menu.itemCount > 0 ? (
                        <span>{menu.itemCount} item{menu.itemCount !== 1 ? 's' : ''}</span>
                      ) : (
                        <span className="text-gray-500">Empty</span>
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
              onDragOver={(e) => handleMenuDragOver(e, position)}
              onDragLeave={handleMenuDragLeave}
              onDrop={(e) => handleMenuDrop(e, position)}
              className={`bg-gray-800/50 border border-dashed rounded-lg p-4 flex items-center justify-between transition-all ${
                dragOverPosition === position
                  ? 'border-orange-500 bg-orange-600/20 ring-2 ring-orange-500'
                  : 'border-gray-700'
              }`}
            >
              <div className="flex items-center gap-4">
                <div className="w-8 h-8 bg-gray-700 rounded-lg flex items-center justify-center font-bold text-lg text-gray-500">
                  {position}
                </div>
                <span className="text-gray-500">
                  {dragOverPosition === position ? 'Drop here' : 'Empty slot'}
                </span>
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

      {/* Unassigned Menus */}
      {unassignedMenus.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-gray-400 mb-3">
            Unassigned Menus ({unassignedMenus.length})
          </h3>
          <div className="grid gap-2">
            {unassignedMenus.map((menu) => (
              <div
                key={menu.id}
                draggable
                onDragStart={(e) => handleMenuDragStart(e, menu)}
                onDragEnd={handleMenuDragEnd}
                className={`bg-gray-800/50 border border-dashed border-gray-600 rounded-lg p-3 flex items-center justify-between cursor-grab active:cursor-grabbing ${
                  draggedMenu?.id === menu.id ? 'opacity-50' : ''
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className="text-gray-500 text-xs">⋮⋮</span>
                  <div>
                    <div className="font-medium text-gray-300">{menu.menuName}</div>
                    <div className="text-xs text-gray-500">
                      {menu.itemCount > 0 ? (
                        <span>{menu.itemCount} item{menu.itemCount !== 1 ? 's' : ''}</span>
                      ) : (
                        <span>Empty - click Edit to add items</span>
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
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Drag unassigned menus to an empty slot above to activate them.
          </p>
        </div>
      )}

      {/* Menu Preview */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="font-medium mb-3">In-Game Preview</h3>
        <div className="inline-block bg-black/80 rounded-lg border border-gray-600 p-3 font-mono text-sm">
          <div className="text-orange-400 mb-2 border-b border-gray-600 pb-1">
            ♪ Sound Menu
          </div>
          {menus.filter(m => m.parentId === null && m.menuPosition > 0).length === 0 ? (
            <div className="text-gray-500 italic">No menus configured</div>
          ) : (
            menus
              .filter(m => m.parentId === null && m.menuPosition > 0)
              .sort((a, b) => a.menuPosition - b.menuPosition)
              .map((menu) => (
                <div key={menu.id} className="flex items-center gap-2 py-0.5">
                  <span className="text-yellow-400">{menu.menuPosition}.</span>
                  <span className="text-cyan-400">{menu.menuName}</span>
                  <span className="text-gray-400 ml-auto">→</span>
                </div>
              ))
          )}
          <div className="text-gray-500 text-xs mt-2 border-t border-gray-600 pt-1">
            1-9 select, 0 next page, BKSP back
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
                <label className="block text-sm text-gray-400 mb-1">Position</label>
                <select
                  value={menuPosition}
                  onChange={(e) => setMenuPosition(parseInt(e.target.value))}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-4 py-2 text-white focus:outline-none focus:border-orange-500"
                >
                  <option value={0}>Unassigned (save for later)</option>
                  {getAvailablePositions(editingMenu?.id).map((pos) => (
                    <option key={pos} value={pos}>
                      Position {pos}
                    </option>
                  ))}
                  {editingMenu && editingMenu.menuPosition > 0 && (
                    <option value={editingMenu.menuPosition}>
                      Position {editingMenu.menuPosition} (current)
                    </option>
                  )}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Unassigned menus can be populated and then dragged to a slot later.
                </p>
              </div>

              {/* Menu Items - can add sounds, playlists, or nested menus */}
              {editingMenu && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm text-gray-400">
                      Menu Items
                    </label>
                    {menuItems.length < 9 && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setAddingItemMode('sound');
                            setAddingItemPosition(getNextItemPosition());
                          }}
                          className="text-sm text-orange-400 hover:text-orange-300"
                        >
                          + Sound
                        </button>
                        <button
                          onClick={() => {
                            setAddingItemMode('playlist');
                            setAddingItemPosition(getNextItemPosition());
                          }}
                          className="text-sm text-blue-400 hover:text-blue-300"
                        >
                          + Playlist
                        </button>
                        <button
                          onClick={() => {
                            setAddingItemMode('menu');
                            setAddingItemPosition(getNextItemPosition());
                          }}
                          className="text-sm text-cyan-400 hover:text-cyan-300"
                        >
                          + Sub-Menu
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Items list with drag-drop */}
                  <div className="space-y-1 bg-gray-900 rounded-lg p-2">
                    {menuItems.length === 0 ? (
                      <div className="text-gray-500 text-center py-4">
                        No items added yet. Add sounds, playlists, or sub-menus above.
                      </div>
                    ) : (
                      menuItems.map((item, index) => (
                        <div
                          key={item.id}
                          draggable
                          onDragStart={(e) => handleDragStart(e, item, index)}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, index)}
                          onDragEnd={handleDragEnd}
                          className={`flex items-center gap-2 p-2 rounded transition-colors cursor-grab active:cursor-grabbing ${
                            dragOverIndex === index
                              ? 'bg-orange-600/30 border-2 border-orange-500'
                              : 'bg-gray-800 hover:bg-gray-700'
                          }`}
                        >
                          <span className="text-gray-500 text-xs">⋮⋮</span>
                          <span className="w-6 text-center font-bold text-orange-400">
                            {index + 1}
                          </span>
                          {item.itemType === 'menu' ? (
                            <>
                              <span className="text-cyan-400">📁</span>
                              <span className="flex-1 text-cyan-400">{item.displayName}</span>
                              <span className="text-xs text-gray-500">sub-menu</span>
                            </>
                          ) : item.itemType === 'playlist' ? (
                            <>
                              <span className="text-blue-400">📋</span>
                              <span className="flex-1 text-blue-400">{item.displayName}</span>
                              <span className="text-xs text-gray-500">
                                {item.playlistSoundCount || 0} sounds
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="text-white">🔊</span>
                              <span className="flex-1">{item.displayName}</span>
                              <span className="text-xs text-gray-500">
                                {formatDuration(item.durationSeconds)}
                              </span>
                            </>
                          )}
                          <button
                            onClick={() =>
                              editingMenu &&
                              removeItemMutation.mutate({ menuId: editingMenu.id, itemId: item.id })
                            }
                            className="text-red-400 hover:text-red-300 text-xs"
                          >
                            ✕
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Add sound picker */}
                  {addingItemMode === 'sound' && addingItemPosition !== null && (
                    <div className="mt-2 bg-gray-700 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm text-gray-400">Add sound at position {menuItems.length + 1}:</span>
                        <button
                          onClick={() => {
                            setAddingItemMode(null);
                            setAddingItemPosition(null);
                          }}
                          className="text-gray-400 hover:text-white ml-auto"
                        >
                          ✕
                        </button>
                      </div>
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search your sounds..."
                        className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-orange-500 mb-2"
                        autoFocus
                      />
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {filteredSounds.slice(0, 20).map((sound) => (
                          <button
                            key={sound.id}
                            onClick={() => {
                              if (editingMenu && addingItemPosition !== null) {
                                addSoundItemMutation.mutate({
                                  menuId: editingMenu.id,
                                  soundAlias: sound.alias,
                                  position: addingItemPosition,
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

                  {/* Add nested menu picker */}
                  {addingItemMode === 'menu' && addingItemPosition !== null && (
                    <div className="mt-2 bg-gray-700 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm text-gray-400">Add sub-menu at position {menuItems.length + 1}:</span>
                        <button
                          onClick={() => {
                            setAddingItemMode(null);
                            setAddingItemPosition(null);
                          }}
                          className="text-gray-400 hover:text-white ml-auto"
                        >
                          ✕
                        </button>
                      </div>
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search menus..."
                        className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-orange-500 mb-2"
                        autoFocus
                      />
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {getAvailableNestedMenus().slice(0, 20).map((menu) => (
                          <button
                            key={menu.id}
                            onClick={() => {
                              if (editingMenu && addingItemPosition !== null) {
                                addNestedMenuItemMutation.mutate({
                                  menuId: editingMenu.id,
                                  nestedMenuId: menu.id,
                                  position: addingItemPosition,
                                });
                              }
                            }}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-600 flex items-center justify-between"
                          >
                            <span className="text-cyan-400">📁 {menu.menuName}</span>
                            <span className="text-xs text-gray-500">
                              {menu.itemCount} item{menu.itemCount !== 1 ? 's' : ''}
                            </span>
                          </button>
                        ))}
                        {getAvailableNestedMenus().length === 0 && (
                          <div className="text-gray-500 text-sm text-center py-2">
                            No menus available
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Add playlist picker */}
                  {addingItemMode === 'playlist' && addingItemPosition !== null && (
                    <div className="mt-2 bg-gray-700 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm text-gray-400">Add playlist at position {menuItems.length + 1}:</span>
                        <button
                          onClick={() => {
                            setAddingItemMode(null);
                            setAddingItemPosition(null);
                          }}
                          className="text-gray-400 hover:text-white ml-auto"
                        >
                          ✕
                        </button>
                      </div>
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search playlists..."
                        className="w-full bg-gray-600 border border-gray-500 rounded px-3 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-none focus:border-orange-500 mb-2"
                        autoFocus
                      />
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {filteredPlaylists.slice(0, 20).map((playlist) => (
                          <button
                            key={playlist.id}
                            onClick={() => {
                              if (editingMenu && addingItemPosition !== null) {
                                addPlaylistItemMutation.mutate({
                                  menuId: editingMenu.id,
                                  playlistId: playlist.id,
                                  position: addingItemPosition,
                                });
                              }
                            }}
                            className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-600 flex items-center justify-between"
                          >
                            <span className="text-blue-400">📋 {playlist.name}</span>
                            <span className="text-xs text-gray-500">
                              {playlist.soundCount || 0} sound{(playlist.soundCount || 0) !== 1 ? 's' : ''}
                            </span>
                          </button>
                        ))}
                        {filteredPlaylists.length === 0 && (
                          <div className="text-gray-500 text-sm text-center py-2">
                            No playlists found
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
