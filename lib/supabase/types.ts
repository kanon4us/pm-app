export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      users: {
        Row: { id: string; email: string; clickup_workspace_id: string | null; created_at: string }
        Insert: { id?: string; email: string; clickup_workspace_id?: string | null }
        Update: { email?: string; clickup_workspace_id?: string | null }
      }
      oauth_tokens: {
        Row: {
          id: string; user_id: string; provider: 'clickup' | 'figma' | 'webflow' | 'github'
          access_token: string; refresh_token: string | null; token_expires_at: string | null
          scopes: string[] | null; created_at: string; updated_at: string
        }
        Insert: {
          id?: string; user_id: string; provider: 'clickup' | 'figma' | 'webflow' | 'github'
          access_token: string; refresh_token?: string | null; token_expires_at?: string | null
          scopes?: string[] | null
        }
        Update: { access_token?: string; refresh_token?: string | null; token_expires_at?: string | null }
      }
      lists: {
        Row: { id: string; user_id: string; clickup_list_id: string; name: string; webhook_id: string | null; synced_at: string | null; created_at: string }
        Insert: { id?: string; user_id: string; clickup_list_id: string; name: string; webhook_id?: string | null }
        Update: { name?: string; webhook_id?: string | null; synced_at?: string | null }
      }
      tasks: {
        Row: {
          id: string; clickup_task_id: string; list_id: string; sprint_id: string | null
          name: string; status: string; custom_fields: Json; fvi_score: number | null
          cost_effort: number | null; cost_risk: number | null; inverted_influence: number | null
          git_branch: string | null; is_feature_flagged: boolean; synced_at: string | null; created_at: string
        }
        Insert: { id?: string; clickup_task_id: string; list_id: string; name: string; status?: string; custom_fields?: Json }
        Update: { status?: string; custom_fields?: Json; fvi_score?: number | null; cost_effort?: number | null; cost_risk?: number | null; inverted_influence?: number | null; git_branch?: string | null; is_feature_flagged?: boolean; sprint_id?: string | null; synced_at?: string | null }
      }
      sprints: {
        Row: { id: string; clickup_sprint_id: string | null; name: string; start_date: string | null; end_date: string | null; cost_budget: number; is_active: boolean; status: 'planned' | 'active' | 'completed'; created_at: string }
        Insert: { id?: string; name: string; cost_budget?: number; clickup_sprint_id?: string | null; start_date?: string | null; end_date?: string | null }
        Update: { name?: string; cost_budget?: number; is_active?: boolean; status?: 'planned' | 'active' | 'completed' }
      }
      trigger_configs: {
        Row: { id: string; list_id: string; from_status: string | null; to_status: string; pm_agent_action: string; write_back_order: string[]; write_back_config: Json; on_failure: 'continue' | 'stop'; created_at: string }
        Insert: { id?: string; list_id: string; to_status: string; pm_agent_action: string; from_status?: string | null; write_back_order?: string[]; write_back_config?: Json; on_failure?: 'continue' | 'stop' }
        Update: { to_status?: string; pm_agent_action?: string; from_status?: string | null; write_back_order?: string[]; write_back_config?: Json; on_failure?: 'continue' | 'stop' }
      }
      trigger_queue: {
        Row: { id: string; task_id: string; config_id: string; status: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed'; approved_by: string | null; agent_output: Json | null; error_details: Json | null; created_at: string; updated_at: string }
        Insert: { id?: string; task_id: string; config_id: string; status?: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed' }
        Update: { status?: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed'; approved_by?: string | null; agent_output?: Json | null; error_details?: Json | null; updated_at?: string }
      }
      objective_assessments: {
        Row: { id: string; task_id: string; objective_id: number; score: number; reasoning: string | null; assessed_at: string }
        Insert: { id?: string; task_id: string; objective_id: number; score: number; reasoning?: string | null }
        Update: { score?: number; reasoning?: string | null }
      }
      skills_library: {
        Row: { id: string; role_slug: string; skill_path: string; content_snapshot: string | null; updated_at: string }
        Insert: { id?: string; role_slug: string; skill_path: string; content_snapshot?: string | null }
        Update: { skill_path?: string; content_snapshot?: string | null; updated_at?: string }
      }
      repo_registry: {
        Row: { id: string; repo_name: string; domain: string[]; readme_url: string | null; is_active: boolean; created_at: string }
        Insert: { id?: string; repo_name: string; domain?: string[]; readme_url?: string | null }
        Update: { domain?: string[]; readme_url?: string | null; is_active?: boolean }
      }
      sync_logs: {
        Row: { id: string; integration: 'webflow' | 'figma' | 'github' | 'clickup'; entity_id: string; status: 'success' | 'failed'; details: Json | null; synced_at: string }
        Insert: { id?: string; integration: 'webflow' | 'figma' | 'github' | 'clickup'; entity_id: string; status: 'success' | 'failed'; details?: Json | null }
        Update: never
      }
    }
  }
}

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
export type InsertDto<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Insert']
export type UpdateDto<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Update']
