import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { users, type AdminUser, type CreateUserRequest, type UpdateUserRequest } from '../api/client';
import { useAuthStore } from '../stores/auth';

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const roleColors: Record<string, string> = {
  admin: 'bg-red-900 text-red-300',
  moderator: 'bg-yellow-900 text-yellow-300',
  user: 'bg-gray-700 text-gray-300',
};

export default function Users() {
  const currentUser = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AdminUser | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    email: '',
    displayName: '',
    password: '',
    role: 'user' as 'admin' | 'moderator' | 'user',
  });
  const [formError, setFormError] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['users'],
    queryFn: users.list,
  });

  const createMutation = useMutation({
    mutationFn: users.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setShowCreateModal(false);
      resetForm();
    },
    onError: (err: Error) => {
      setFormError(err.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateUserRequest }) => users.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditingUser(null);
      resetForm();
    },
    onError: (err: Error) => {
      setFormError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: users.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setDeleteConfirm(null);
    },
  });

  const resetForm = () => {
    setFormData({ email: '', displayName: '', password: '', role: 'user' });
    setFormError('');
  };

  const openCreateModal = () => {
    resetForm();
    setShowCreateModal(true);
  };

  const openEditModal = (user: AdminUser) => {
    setFormData({
      email: user.email,
      displayName: user.displayName,
      password: '',
      role: user.role,
    });
    setFormError('');
    setEditingUser(user);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!formData.email || !formData.displayName || !formData.password) {
      setFormError('All fields are required');
      return;
    }

    if (formData.password.length < 8) {
      setFormError('Password must be at least 8 characters');
      return;
    }

    createMutation.mutate(formData as CreateUserRequest);
  };

  const handleUpdateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (!editingUser) return;

    const updates: UpdateUserRequest = {};

    if (formData.email !== editingUser.email) {
      updates.email = formData.email;
    }
    if (formData.displayName !== editingUser.displayName) {
      updates.displayName = formData.displayName;
    }
    if (formData.role !== editingUser.role) {
      updates.role = formData.role;
    }
    if (formData.password) {
      if (formData.password.length < 8) {
        setFormError('Password must be at least 8 characters');
        return;
      }
      updates.password = formData.password;
    }

    if (Object.keys(updates).length === 0) {
      setEditingUser(null);
      return;
    }

    updateMutation.mutate({ id: editingUser.id, data: updates });
  };

  if (currentUser?.role !== 'admin') {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-6">
        <h2 className="text-xl font-bold text-red-400">Access Denied</h2>
        <p className="text-gray-400 mt-2">You must be an admin to access user management.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading users...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-4">
        <p className="text-red-400">Failed to load users</p>
      </div>
    );
  }

  const userList = data?.users || [];

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-xl md:text-2xl font-bold">User Management</h1>
        <button
          onClick={openCreateModal}
          className="px-4 py-2.5 md:py-2 bg-orange-600 hover:bg-orange-500 rounded font-medium transition-colors text-sm md:text-base"
        >
          + Add User
        </button>
      </div>

      {/* Mobile: Card Layout */}
      <div className="md:hidden space-y-3">
        {userList.map((user) => (
          <div key={user.id} className="bg-gray-800 rounded-lg p-4">
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="font-medium">
                  {user.displayName}
                  {user.id === currentUser?.id && (
                    <span className="text-xs text-gray-500 ml-1">(you)</span>
                  )}
                </div>
                <div className="text-sm text-gray-400 break-all">{user.email}</div>
              </div>
              <span className={`px-2 py-1 rounded text-xs font-medium ${roleColors[user.role]}`}>
                {user.role}
              </span>
            </div>
            <div className="text-xs text-gray-500 mb-3">
              Created: {formatDate(user.createdAt)}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => openEditModal(user)}
                className="flex-1 px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Edit
              </button>
              {user.id !== currentUser?.id && (
                <button
                  onClick={() => setDeleteConfirm(user)}
                  className="px-3 py-2 text-sm bg-red-900 hover:bg-red-800 text-red-300 rounded transition-colors"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Desktop: Table Layout */}
      <div className="hidden md:block bg-gray-800 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="text-left text-gray-400 border-b border-gray-700 bg-gray-900">
              <th className="px-6 py-3">Display Name</th>
              <th className="px-6 py-3">Email</th>
              <th className="px-6 py-3">Role</th>
              <th className="px-6 py-3">Created</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {userList.map((user) => (
              <tr key={user.id} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td className="px-6 py-4">
                  <div className="font-medium">{user.displayName}</div>
                  {user.id === currentUser?.id && (
                    <span className="text-xs text-gray-500">(you)</span>
                  )}
                </td>
                <td className="px-6 py-4 text-gray-400">{user.email}</td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded text-xs font-medium ${roleColors[user.role]}`}>
                    {user.role}
                  </span>
                </td>
                <td className="px-6 py-4 text-gray-400">{formatDate(user.createdAt)}</td>
                <td className="px-6 py-4 text-right">
                  <button
                    onClick={() => openEditModal(user)}
                    className="px-3 py-1 text-sm bg-gray-700 hover:bg-gray-600 rounded mr-2 transition-colors"
                  >
                    Edit
                  </button>
                  {user.id !== currentUser?.id && (
                    <button
                      onClick={() => setDeleteConfirm(user)}
                      className="px-3 py-1 text-sm bg-red-900 hover:bg-red-800 text-red-300 rounded transition-colors"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-4 md:p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <h3 className="text-base md:text-lg font-semibold mb-4">Create New User</h3>
            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Display Name (ET Name)</label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                  placeholder="ETMan"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                  placeholder="user@example.com"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Password</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                  placeholder="Minimum 8 characters"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as typeof formData.role })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="user">User (read-only)</option>
                  <option value="moderator">Moderator</option>
                  <option value="admin">Admin (full access)</option>
                </select>
              </div>
              {formError && (
                <div className="text-red-400 text-sm">{formError}</div>
              )}
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2.5 md:py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2.5 md:py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 rounded font-medium transition-colors"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-4 md:p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <h3 className="text-base md:text-lg font-semibold mb-4">Edit User</h3>
            <form onSubmit={handleUpdateSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Display Name (ET Name)</label>
                <input
                  type="text"
                  value={formData.displayName}
                  onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Email</label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">New Password (leave blank to keep)</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                  placeholder="Leave blank to keep current"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value as typeof formData.role })}
                  className="w-full bg-gray-700 rounded px-3 py-2.5 md:py-2 text-base focus:outline-none focus:ring-2 focus:ring-orange-500"
                  disabled={editingUser.id === currentUser?.id}
                >
                  <option value="user">User (read-only)</option>
                  <option value="moderator">Moderator</option>
                  <option value="admin">Admin (full access)</option>
                </select>
                {editingUser.id === currentUser?.id && (
                  <p className="text-xs text-gray-500 mt-1">You cannot change your own role</p>
                )}
              </div>
              {formError && (
                <div className="text-red-400 text-sm">{formError}</div>
              )}
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setEditingUser(null)}
                  className="px-4 py-2.5 md:py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="px-4 py-2.5 md:py-2 bg-orange-600 hover:bg-orange-500 disabled:bg-gray-600 rounded font-medium transition-colors"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-800 rounded-lg p-4 md:p-6 w-full max-w-md">
            <h3 className="text-base md:text-lg font-semibold mb-4 text-red-400">Delete User</h3>
            <p className="text-gray-300 mb-4 text-sm md:text-base">
              Are you sure you want to delete <strong>{deleteConfirm.displayName}</strong>?
              This action cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2.5 md:py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirm.id)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2.5 md:py-2 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 rounded font-medium transition-colors"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
