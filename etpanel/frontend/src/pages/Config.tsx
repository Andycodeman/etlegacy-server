import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { config, server } from '../api/client';
import type { ConfigTemplate, ConfigTemplateDetail } from '../api/client';
import { useAuthStore } from '../stores/auth';

type TabType = 'server' | 'templates' | 'mapfiles';

export default function Config() {
  const currentUser = useAuthStore((s) => s.user);

  // Block non-admin users
  if (currentUser?.role !== 'admin') {
    return (
      <div className="bg-red-900/30 border border-red-500 rounded-lg p-6">
        <h2 className="text-xl font-bold text-red-400">Access Denied</h2>
        <p className="text-gray-400 mt-2">You must be an admin to access server configuration.</p>
      </div>
    );
  }
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabType>('server');
  const [editedCvars, setEditedCvars] = useState<Record<string, string>>({});
  const [newTemplateName, setNewTemplateName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<ConfigTemplateDetail | null>(null);
  const [selectedMapFile, setSelectedMapFile] = useState<string | null>(null);
  const [mapFileEditedCvars, setMapFileEditedCvars] = useState<Record<string, string>>({});
  const [newMapFileName, setNewMapFileName] = useState('');
  const [saveAsMapName, setSaveAsMapName] = useState('');

  // Fetch current server CVARs
  const { data: cvarData, isLoading } = useQuery({
    queryKey: ['cvars'],
    queryFn: config.getCvars,
  });

  // Fetch server status to get current map
  const { data: serverStatus } = useQuery({
    queryKey: ['serverStatus'],
    queryFn: server.status,
    refetchInterval: 10000,
  });

  // Fetch templates
  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: config.getTemplates,
  });

  // Fetch map config files
  const { data: mapFiles } = useQuery({
    queryKey: ['mapfiles'],
    queryFn: config.getMapFiles,
  });

  // Fetch selected map file content
  const { data: mapFileContent } = useQuery({
    queryKey: ['mapfile', selectedMapFile],
    queryFn: () => config.getMapFile(selectedMapFile!),
    enabled: !!selectedMapFile,
  });

  // Server CVAR update mutation
  const updateCvarsMutation = useMutation({
    mutationFn: (cvars: Record<string, string>) => config.setCvars(cvars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cvars'] });
      setEditedCvars({});
    },
  });

  // Template mutations
  const saveTemplateMutation = useMutation({
    mutationFn: ({ name, cvars }: { name: string; cvars: Record<string, string> }) =>
      config.saveTemplate(name, cvars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setNewTemplateName('');
    },
  });

  const applyTemplateMutation = useMutation({
    mutationFn: (id: number) => config.applyTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cvars'] });
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: number) => config.deleteTemplate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setSelectedTemplate(null);
    },
  });

  const saveTemplateAsMapConfigMutation = useMutation({
    mutationFn: ({ id, mapName }: { id: number; mapName: string }) =>
      config.saveTemplateAsMapConfig(id, mapName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mapfiles'] });
      setSaveAsMapName('');
    },
  });

  // Map file mutations
  const saveMapFileMutation = useMutation({
    mutationFn: ({ mapName, cvars }: { mapName: string; cvars: Record<string, string> }) =>
      config.saveMapFile(mapName, cvars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mapfiles'] });
      queryClient.invalidateQueries({ queryKey: ['mapfile'] });
      setMapFileEditedCvars({});
      setNewMapFileName('');
    },
  });

  const deleteMapFileMutation = useMutation({
    mutationFn: (mapName: string) => config.deleteMapFile(mapName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mapfiles'] });
      setSelectedMapFile(null);
    },
  });

  const handleSaveServerCvars = () => {
    if (Object.keys(editedCvars).length > 0) {
      updateCvarsMutation.mutate(editedCvars);
    }
  };

  const handleCvarChange = (cvar: string, value: string) => {
    setEditedCvars((prev) => ({ ...prev, [cvar]: value }));
  };

  const handleSaveAsTemplate = () => {
    if (newTemplateName && cvarData?.cvars) {
      saveTemplateMutation.mutate({ name: newTemplateName, cvars: { ...cvarData.cvars, ...editedCvars } });
    }
  };

  const handleSelectTemplate = async (template: ConfigTemplate) => {
    const detail = await config.getTemplate(template.id);
    setSelectedTemplate(detail);
  };

  const handleMapFileCvarChange = (cvar: string, value: string) => {
    setMapFileEditedCvars((prev) => ({ ...prev, [cvar]: value }));
  };

  const handleSaveMapFile = () => {
    if (selectedMapFile) {
      const cvars = { ...(mapFileContent?.cvars || {}), ...mapFileEditedCvars };
      saveMapFileMutation.mutate({ mapName: selectedMapFile, cvars });
    }
  };

  const handleCreateMapFile = () => {
    if (newMapFileName && cvarData?.cvars) {
      saveMapFileMutation.mutate({ mapName: newMapFileName, cvars: cvarData.cvars });
      setSelectedMapFile(newMapFileName);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-400">Loading configuration...</div>
      </div>
    );
  }

  const allCvars = { ...cvarData?.cvars, ...editedCvars };
  const hasServerChanges = Object.keys(editedCvars).length > 0;
  const hasMapFileChanges = Object.keys(mapFileEditedCvars).length > 0;
  const currentMap = serverStatus?.map;

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 className="text-xl md:text-2xl font-bold">Server Configuration</h1>
        <div className="flex items-center gap-2">
          {activeTab === 'server' && hasServerChanges && (
            <button
              onClick={handleSaveServerCvars}
              disabled={updateCvarsMutation.isPending}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors text-sm md:text-base"
            >
              {updateCvarsMutation.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          )}
          {activeTab === 'mapfiles' && selectedMapFile && hasMapFileChanges && (
            <button
              onClick={handleSaveMapFile}
              disabled={saveMapFileMutation.isPending}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors text-sm md:text-base"
            >
              {saveMapFileMutation.isPending ? 'Saving...' : 'Save Map Config'}
            </button>
          )}
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex overflow-x-auto hide-scrollbar border-b border-gray-700 -mx-4 px-4 md:mx-0 md:px-0">
        <button
          onClick={() => setActiveTab('server')}
          className={`px-3 md:px-4 py-2 font-medium transition-colors whitespace-nowrap text-sm md:text-base ${
            activeTab === 'server'
              ? 'text-orange-400 border-b-2 border-orange-400'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          Live Server
        </button>
        <button
          onClick={() => setActiveTab('templates')}
          className={`px-3 md:px-4 py-2 font-medium transition-colors whitespace-nowrap text-sm md:text-base ${
            activeTab === 'templates'
              ? 'text-orange-400 border-b-2 border-orange-400'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          Templates ({templates?.length || 0})
        </button>
        <button
          onClick={() => setActiveTab('mapfiles')}
          className={`px-3 md:px-4 py-2 font-medium transition-colors whitespace-nowrap text-sm md:text-base ${
            activeTab === 'mapfiles'
              ? 'text-orange-400 border-b-2 border-orange-400'
              : 'text-gray-400 hover:text-white'
          }`}
        >
          Map Configs ({mapFiles?.length || 0})
        </button>
      </div>

      {/* Server Settings Tab */}
      {activeTab === 'server' && (
        <div className="space-y-4 md:space-y-6">
          {/* Save as Template */}
          <div className="bg-gray-800 rounded-lg p-3 md:p-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                placeholder="Template name (e.g., panzerwar, chill)"
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                className="flex-1 px-3 py-2.5 md:py-2 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-orange-500 text-base"
              />
              <button
                onClick={handleSaveAsTemplate}
                disabled={!newTemplateName || saveTemplateMutation.isPending}
                className="px-4 py-2.5 md:py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors whitespace-nowrap"
              >
                {saveTemplateMutation.isPending ? 'Saving...' : 'Save as Template'}
              </button>
            </div>
            {saveTemplateMutation.isSuccess && (
              <p className="text-green-400 text-sm mt-2">Template saved!</p>
            )}
          </div>

          {/* CVAR Grid */}
          <div className="bg-gray-800 rounded-lg p-4 md:p-6">
            <h2 className="text-base md:text-lg font-semibold mb-4">
              Game Settings {currentMap && <span className="text-gray-400 text-xs md:text-sm ml-2">(Playing: {currentMap})</span>}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
              {cvarData?.allowed.map((cvar) => (
                <div key={cvar} className="space-y-1">
                  <label className="block text-xs md:text-sm text-gray-400 truncate">{cvar}</label>
                  <input
                    type="text"
                    value={allCvars[cvar] || ''}
                    onChange={(e) => handleCvarChange(cvar, e.target.value)}
                    className={`w-full px-3 py-2.5 md:py-2 bg-gray-700 border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-base md:text-sm ${
                      editedCvars[cvar] !== undefined ? 'border-orange-500' : 'border-gray-600'
                    }`}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Templates Tab */}
      {activeTab === 'templates' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
          {/* Template List */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-base md:text-lg font-semibold mb-4">Saved Templates</h2>
            <div className="space-y-2">
              {templates?.map((template) => (
                <div
                  key={template.id}
                  onClick={() => handleSelectTemplate(template)}
                  className={`p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedTemplate?.id === template.id
                      ? 'bg-orange-600/30 border border-orange-500'
                      : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                >
                  <div className="font-medium">{template.name}</div>
                  <div className="text-sm text-gray-400">
                    by {template.createdBy || 'Unknown'}
                  </div>
                </div>
              ))}
              {(!templates || templates.length === 0) && (
                <p className="text-gray-400 text-sm">No templates saved yet. Go to Live Server tab to save one.</p>
              )}
            </div>
          </div>

          {/* Template Details */}
          <div className="lg:col-span-2 bg-gray-800 rounded-lg p-4">
            {selectedTemplate ? (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                  <h2 className="text-base md:text-lg font-semibold">{selectedTemplate.name}</h2>
                  <div className="flex gap-2">
                    <button
                      onClick={() => applyTemplateMutation.mutate(selectedTemplate.id)}
                      disabled={applyTemplateMutation.isPending}
                      className="flex-1 sm:flex-none px-3 md:px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors text-sm md:text-base"
                    >
                      {applyTemplateMutation.isPending ? 'Applying...' : 'Apply'}
                    </button>
                    <button
                      onClick={() => deleteTemplateMutation.mutate(selectedTemplate.id)}
                      disabled={deleteTemplateMutation.isPending}
                      className="px-3 md:px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors text-sm md:text-base"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {applyTemplateMutation.isSuccess && (
                  <div className="bg-green-900/30 border border-green-500 rounded-lg p-3 text-green-400 mb-4">
                    Template applied to server!
                  </div>
                )}

                {/* Save as Map Config */}
                <div className="bg-gray-700 rounded-lg p-3 md:p-4 mb-4">
                  <h3 className="font-medium mb-2 text-sm md:text-base">Save as Map Config File</h3>
                  <p className="text-xs md:text-sm text-gray-400 mb-3">
                    This will create a .cfg file that auto-loads when the map starts.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      placeholder={currentMap || 'Map name (e.g., fueldump)'}
                      value={saveAsMapName}
                      onChange={(e) => setSaveAsMapName(e.target.value)}
                      className="flex-1 px-3 py-2.5 md:py-2 bg-gray-600 border border-gray-500 rounded-lg focus:ring-2 focus:ring-orange-500 text-base md:text-sm"
                    />
                    <button
                      onClick={() => saveTemplateAsMapConfigMutation.mutate({
                        id: selectedTemplate.id,
                        mapName: saveAsMapName || currentMap || ''
                      })}
                      disabled={(!saveAsMapName && !currentMap) || saveTemplateAsMapConfigMutation.isPending}
                      className="px-4 py-2.5 md:py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors whitespace-nowrap text-sm"
                    >
                      {saveTemplateAsMapConfigMutation.isPending ? 'Saving...' : 'Save as Map Config'}
                    </button>
                  </div>
                  {saveTemplateAsMapConfigMutation.isSuccess && (
                    <p className="text-green-400 text-sm mt-2">Map config file saved!</p>
                  )}
                </div>

                {/* Template CVARs */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {Object.entries(selectedTemplate.configJson || {}).map(([cvar, value]) => (
                    <div key={cvar} className="bg-gray-700 rounded px-3 py-2 text-sm">
                      <span className="text-gray-400 break-all">{cvar}:</span>{' '}
                      <span className="text-white break-all">{value}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="text-center text-gray-400 py-12">
                Select a template to view details
              </div>
            )}
          </div>
        </div>
      )}

      {/* Map Config Files Tab */}
      {activeTab === 'mapfiles' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
          {/* Map File List */}
          <div className="bg-gray-800 rounded-lg p-4">
            <h2 className="text-base md:text-lg font-semibold mb-3 md:mb-4">Map Config Files</h2>
            <p className="text-xs md:text-sm text-gray-400 mb-3 md:mb-4">
              These files auto-load when the map starts.
            </p>

            {/* Create new map config */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder={currentMap || 'Map name'}
                value={newMapFileName}
                onChange={(e) => setNewMapFileName(e.target.value)}
                className="flex-1 px-3 py-2.5 md:py-2 bg-gray-700 border border-gray-600 rounded-lg focus:ring-2 focus:ring-orange-500 text-base md:text-sm"
              />
              <button
                onClick={handleCreateMapFile}
                disabled={(!newMapFileName && !currentMap) || saveMapFileMutation.isPending}
                className="px-3 py-2.5 md:py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors text-sm"
              >
                Create
              </button>
            </div>

            <div className="space-y-2 max-h-[300px] md:max-h-none overflow-y-auto">
              {mapFiles?.map((mapName) => (
                <div
                  key={mapName}
                  onClick={() => {
                    setSelectedMapFile(mapName);
                    setMapFileEditedCvars({});
                  }}
                  className={`p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedMapFile === mapName
                      ? 'bg-orange-600/30 border border-orange-500'
                      : mapName === currentMap
                      ? 'bg-green-600/20 border border-green-500/50 hover:bg-green-600/30'
                      : 'bg-gray-700 hover:bg-gray-600'
                  }`}
                >
                  <div className="font-medium">
                    {mapName}.cfg
                    {mapName === currentMap && (
                      <span className="ml-2 text-xs text-green-400">(current map)</span>
                    )}
                  </div>
                </div>
              ))}
              {(!mapFiles || mapFiles.length === 0) && (
                <p className="text-gray-400 text-sm">No map config files found.</p>
              )}
            </div>
          </div>

          {/* Map File Editor */}
          <div className="lg:col-span-2 bg-gray-800 rounded-lg p-4">
            {selectedMapFile && mapFileContent ? (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                  <h2 className="text-base md:text-lg font-semibold">{selectedMapFile}.cfg</h2>
                  <button
                    onClick={() => deleteMapFileMutation.mutate(selectedMapFile)}
                    disabled={deleteMapFileMutation.isPending}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 rounded-lg font-medium transition-colors text-sm md:text-base"
                  >
                    Delete
                  </button>
                </div>

                {saveMapFileMutation.isSuccess && (
                  <div className="bg-green-900/30 border border-green-500 rounded-lg p-3 text-green-400 mb-4 text-sm">
                    Map config saved!
                  </div>
                )}

                {/* Map File CVARs */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4">
                  {cvarData?.allowed.map((cvar) => {
                    const currentValue = mapFileEditedCvars[cvar] ?? mapFileContent.cvars[cvar] ?? '';
                    const serverValue = cvarData.cvars[cvar] || '';
                    const hasValue = currentValue !== '';
                    const isEdited = mapFileEditedCvars[cvar] !== undefined;

                    return (
                      <div key={cvar} className="space-y-1">
                        <label className="block text-xs md:text-sm text-gray-400 truncate">{cvar}</label>
                        <input
                          type="text"
                          value={currentValue}
                          onChange={(e) => handleMapFileCvarChange(cvar, e.target.value)}
                          placeholder={serverValue || 'Not set'}
                          className={`w-full px-3 py-2.5 md:py-2 bg-gray-700 border rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-base md:text-sm ${
                            isEdited
                              ? 'border-orange-500'
                              : hasValue
                              ? 'border-blue-500/50'
                              : 'border-gray-600'
                          }`}
                        />
                        {hasValue && currentValue !== serverValue && (
                          <div className="text-xs text-blue-400">
                            Server: {serverValue || '(empty)'}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="text-center text-gray-400 py-8 md:py-12 text-sm md:text-base">
                {selectedMapFile ? 'Loading...' : 'Select a map config file to edit, or create a new one'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
