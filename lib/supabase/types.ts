export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Views: Record<string, never>
    Functions: {
      apply_field_mappings: {
        Args: { mappings: Record<string, string> }
        Returns: number
      }
    }
    Tables: {
      users: {
        Row: { id: string; email: string; clickup_workspace_id: string | null; created_at: string }
        Insert: { id?: string; email: string; clickup_workspace_id?: string | null }
        Update: { email?: string; clickup_workspace_id?: string | null }
        Relationships: []
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
        Relationships: []
      }
      lists: {
        Row: { id: string; user_id: string; clickup_list_id: string; name: string; webhook_id: string | null; synced_at: string | null; created_at: string; repo_registry_id: string | null }
        Insert: { id?: string; user_id: string; clickup_list_id: string; name: string; webhook_id?: string | null; repo_registry_id?: string | null }
        Update: { name?: string; webhook_id?: string | null; synced_at?: string | null; repo_registry_id?: string | null }
        Relationships: []
      }
      tasks: {
        Row: {
          id: string; clickup_task_id: string; list_id: string; sprint_id: string | null
          name: string; status: string; custom_fields: Json; fvi_score: number | null
          cost_effort: number | null; cost_risk: number | null; inverted_influence: number | null
          git_branch: string | null; is_feature_flagged: boolean; synced_at: string | null; created_at: string
          kickoff_gate_overrides: Json | null; mapped_fields: Json
        }
        Insert: { id?: string; clickup_task_id: string; list_id: string; name: string; status?: string; custom_fields?: Json; kickoff_gate_overrides?: Json | null; mapped_fields?: Json }
        Update: { status?: string; custom_fields?: Json; fvi_score?: number | null; cost_effort?: number | null; cost_risk?: number | null; inverted_influence?: number | null; git_branch?: string | null; is_feature_flagged?: boolean; sprint_id?: string | null; synced_at?: string | null; kickoff_gate_overrides?: Json | null; mapped_fields?: Json }
        Relationships: []
      }
      sprints: {
        Row: { id: string; clickup_sprint_id: string | null; name: string; start_date: string | null; end_date: string | null; cost_budget: number; is_active: boolean; status: 'planned' | 'active' | 'completed'; created_at: string }
        Insert: { id?: string; name: string; cost_budget?: number; clickup_sprint_id?: string | null; start_date?: string | null; end_date?: string | null }
        Update: { name?: string; cost_budget?: number; is_active?: boolean; status?: 'planned' | 'active' | 'completed' }
        Relationships: []
      }
      trigger_configs: {
        Row: { id: string; list_id: string; from_status: string | null; to_status: string; pm_agent_action: string; write_back_order: string[]; write_back_config: Json; on_failure: 'continue' | 'stop'; created_at: string }
        Insert: { id?: string; list_id: string; to_status: string; pm_agent_action: string; from_status?: string | null; write_back_order?: string[]; write_back_config?: Json; on_failure?: 'continue' | 'stop' }
        Update: { to_status?: string; pm_agent_action?: string; from_status?: string | null; write_back_order?: string[]; write_back_config?: Json; on_failure?: 'continue' | 'stop' }
        Relationships: []
      }
      trigger_queue: {
        Row: { id: string; task_id: string; config_id: string; status: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed'; approved_by: string | null; agent_output: Json | null; error_details: Json | null; created_at: string; updated_at: string }
        Insert: { id?: string; task_id: string; config_id: string; status?: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed' }
        Update: { status?: 'pending' | 'approved' | 'dismissed' | 'running' | 'done' | 'failed'; approved_by?: string | null; agent_output?: Json | null; error_details?: Json | null; updated_at?: string }
        Relationships: []
      }
      objective_assessments: {
        Row: { id: string; task_id: string; objective_id: number; score: number; reasoning: string | null; assessed_at: string }
        Insert: { id?: string; task_id: string; objective_id: number; score: number; reasoning?: string | null }
        Update: { score?: number; reasoning?: string | null }
        Relationships: []
      }
      skills_library: {
        Row: { id: string; role_slug: string; skill_path: string; content_snapshot: string | null; updated_at: string }
        Insert: { id?: string; role_slug: string; skill_path: string; content_snapshot?: string | null }
        Update: { skill_path?: string; content_snapshot?: string | null; updated_at?: string }
        Relationships: []
      }
      repo_registry: {
        Row: { id: string; repo_name: string; github_repo_full_name: string | null; domain: string[]; readme_url: string | null; is_active: boolean; created_at: string }
        Insert: { id?: string; repo_name: string; github_repo_full_name?: string | null; domain?: string[]; readme_url?: string | null }
        Update: { github_repo_full_name?: string | null; domain?: string[]; readme_url?: string | null; is_active?: boolean }
        Relationships: []
      }
      sync_logs: {
        Row: { id: string; integration: 'webflow' | 'figma' | 'github' | 'clickup'; entity_id: string; status: 'success' | 'failed'; details: Json | null; synced_at: string }
        Insert: { id?: string; integration: 'webflow' | 'figma' | 'github' | 'clickup'; entity_id: string; status: 'success' | 'failed'; details?: Json | null }
        Update: never
        Relationships: []
      }
      objectives_registry: {
        Row: { id: string; objective_id: number; name: string; owner_name: string; mandate: string; score_matrix: Json; is_active: boolean; updated_at: string }
        Insert: { id?: string; objective_id: number; name: string; owner_name: string; mandate: string; score_matrix?: Json }
        Update: { name?: string; owner_name?: string; mandate?: string; score_matrix?: Json; is_active?: boolean; updated_at?: string }
        Relationships: []
      }
      role_registry: {
        Row: { id: string; role_name: string; team_domain: string; influence_type: string; weight: number; is_active: boolean }
        Insert: { id?: string; role_name: string; team_domain: string; influence_type: string; weight: number; is_active?: boolean }
        Update: { is_active?: boolean }
        Relationships: []
      }
      assessment_conversations: {
        Row: { id: string; task_id: string; status: 'in_progress' | 'complete' | 'abandoned'; vault_context: Json | null; proposed_scores: Json | null; final_scores: Json | null; effort: number | null; risk: number | null; fvi_score: number | null; vault_spec_content: string | null; affected_workflows: Json | null; is_archived: boolean; created_at: string; completed_at: string | null }
        Insert: { id?: string; task_id: string; status?: 'in_progress' | 'complete' | 'abandoned'; vault_context?: Json | null; proposed_scores?: Json | null; is_archived?: boolean }
        Update: { status?: 'in_progress' | 'complete' | 'abandoned'; proposed_scores?: Json | null; final_scores?: Json | null; effort?: number | null; risk?: number | null; fvi_score?: number | null; vault_spec_content?: string | null; affected_workflows?: Json | null; is_archived?: boolean; completed_at?: string | null }
        Relationships: []
      }
      bundle_generations: {
        Row: { id: string; task_id: string; conversation_id: string; generated_by: string; vault_branch: string | null; vault_spec_url: string | null; files_written: string[]; clickup_fields_written: string[]; clickup_comment_posted: boolean; error_details: Json | null; created_at: string; completed_at: string | null }
        Insert: { id?: string; task_id: string; conversation_id: string; generated_by: string; vault_branch?: string | null; vault_spec_url?: string | null; files_written?: string[]; clickup_fields_written?: string[]; clickup_comment_posted?: boolean; error_details?: Json | null }
        Update: { vault_branch?: string | null; vault_spec_url?: string | null; files_written?: string[]; clickup_fields_written?: string[]; clickup_comment_posted?: boolean; error_details?: Json | null; completed_at?: string | null }
        Relationships: []
      }
      assessment_messages: {
        Row: { id: string; conversation_id: string; role: 'assistant' | 'user'; content: string; objective_id: number | null; proposed_score: number | null; vault_evidence: string | null; created_at: string }
        Insert: { id?: string; conversation_id: string; role: 'assistant' | 'user'; content: string; objective_id?: number | null; proposed_score?: number | null; vault_evidence?: string | null }
        Update: never
        Relationships: []
      }
      conversation_role_assessments: {
        Row: { id: string; conversation_id: string; role_id: string; usage_frequency: number; created_at: string }
        Insert: { id?: string; conversation_id: string; role_id: string; usage_frequency: number }
        Update: never
        Relationships: []
      }
      developer_experiments: {
        Row: {
          id: string
          github_email: string
          github_username: string | null
          vidf_tag: string
          bundle_version: string
          sop_version: string
          sprint: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          github_email: string
          github_username?: string | null
          vidf_tag?: string
          bundle_version?: string
          sop_version?: string
          sprint?: string
        }
        Update: {
          github_username?: string | null
          vidf_tag?: string
          bundle_version?: string
          sop_version?: string
          sprint?: string
          updated_at?: string
        }
        Relationships: []
      }
      bundle_versions: {
        Row: {
          id: string
          version: string
          description: string
          files: Json
          claude_context: string | null
          is_active: boolean
          activated_at: string
          deactivated_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          version: string
          description: string
          files?: Json
          claude_context?: string | null
          is_active?: boolean
          activated_at?: string
        }
        Update: {
          description?: string
          files?: Json
          claude_context?: string | null
          is_active?: boolean
          deactivated_at?: string | null
        }
        Relationships: []
      }
    }
  }
}

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']
export type InsertDto<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Insert']
export type UpdateDto<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Update']
