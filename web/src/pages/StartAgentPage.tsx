import { useState, useEffect } from 'react'

interface ModelOption {
  id: string
  name: string
  description?: string
}

interface StartConfig {
  main_models: ModelOption[]
  subagent_models: ModelOption[]
}

interface StartedAgent {
  agent_id: string
  agent_type: string
  display_name: string
  main_model: string
  subagent_model: string
  status: string
  last_heartbeat: number
  current_prompt_id: string | null
}

export function StartAgentPage() {
  const [config, setConfig] = useState<StartConfig | null>(null)
  const [agentType, setAgentType] = useState<'polarclaw' | 'polarpilot'>('polarclaw')
  const [mainModel, setMainModel] = useState('qwen-3.6-plus')
  const [subagentModel, setSubagentModel] = useState('qwen-3.6-plus')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [startedAgents, setStartedAgents] = useState<StartedAgent[]>([])

  useEffect(() => {
    fetch('/api/agents/start-config')
      .then(r => r.json())
      .then(setConfig)
      .catch(e => setError(e.message))
    
    // 获取已启动的 Agent 列表
    refreshAgents()
  }, [])

  const refreshAgents = () => {
    fetch('/api/agents')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) {
          setStartedAgents(data)
        }
      })
      .catch(() => {})
  }

  const handleStart = async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch('/api/agents/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_type: agentType,
          main_model: mainModel,
          subagent_model: subagentModel,
        }),
      })
      const data = await resp.json()
      if (!resp.ok) {
        setError(data.error || 'Start failed')
      } else {
        // 刷新 Agent 列表
        refreshAgents()
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (!config && !error) {
    return (
      <div className="p-8 text-center text-gray-400">
        Loading...
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Start Agent</h1>

      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg p-4 mb-6 text-red-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* 左侧：创建表单 */}
        <div className="space-y-6">
          {/* Agent Type */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Agent Type</label>
            <div className="flex gap-4">
              {['polarclaw', 'polarpilot'].map(type => (
                <button
                  key={type}
                  onClick={() => setAgentType(type as any)}
                  className={`px-4 py-2 rounded-lg border transition ${
                    agentType === type
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  {type === 'polarclaw' ? 'PolarClaw' : 'PolarPilot'}
                </button>
              ))}
            </div>
          </div>

          {/* Main Model */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Main Model</label>
            <div className="grid grid-cols-1 gap-2">
              {config?.main_models.map(model => (
                <button
                  key={model.id}
                  onClick={() => setMainModel(model.id)}
                  className={`px-3 py-2 rounded-lg border text-left transition ${
                    mainModel === model.id
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  <div className="font-medium">{model.name}</div>
                  {model.description && (
                    <div className="text-xs text-gray-400 mt-1">{model.description}</div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Subagent Model */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Subagent Model</label>
            <div className="grid grid-cols-2 gap-2">
              {config?.subagent_models.map(model => (
                <button
                  key={model.id}
                  onClick={() => setSubagentModel(model.id)}
                  className={`px-3 py-2 rounded-lg border text-center transition ${
                    subagentModel === model.id
                      ? 'bg-blue-600 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  {model.name}
                </button>
              ))}
            </div>
          </div>

          {/* Start Button */}
          <button
            onClick={handleStart}
            disabled={loading}
            className="w-full py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded-lg font-medium transition"
          >
            {loading ? 'Starting...' : 'Start Agent'}
          </button>
        </div>

        {/* 右侧：已启动的 Agent 列表 */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Running Agents</h2>
            <button
              onClick={refreshAgents}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              Refresh
            </button>
          </div>
          
          {startedAgents.length === 0 ? (
            <div className="text-gray-500 text-sm">No agents running</div>
          ) : (
            <div className="space-y-3">
              {startedAgents.map(agent => (
                <div
                  key={agent.agent_id}
                  className="bg-gray-800 border border-gray-700 rounded-lg p-4"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-white">{agent.display_name || agent.agent_id}</div>
                      <div className="text-sm text-gray-400 mt-1">
                        <div>ID: <code className="text-xs">{agent.agent_id}</code></div>
                        <div>Main: {agent.main_model} | Sub: {agent.subagent_model}</div>
                      </div>
                    </div>
                    <span className={`px-2 py-1 rounded text-xs ${
                      agent.status === 'active' 
                        ? 'bg-green-900/50 text-green-400'
                        : agent.status === 'starting'
                        ? 'bg-yellow-900/50 text-yellow-400'
                        : 'bg-gray-700 text-gray-400'
                    }`}>
                      {agent.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
