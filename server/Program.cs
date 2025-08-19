using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using PixieVisio.Server.Data;
using PixieVisio.Server.Models;
using System.Text.Json;
using System.Collections.Generic;
using System.Linq;
using System;
using System.IO;
using Npgsql; // for testing Postgres connectivity
using System.Data.Common;

var builder = WebApplication.CreateBuilder(args);

// CORS (vite dev server)
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins("http://localhost:3000")
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

// get connection string from env or fallback
var envConn = Environment.GetEnvironmentVariable("POSTGRES_CONN");
var defaultConn = "Host=localhost;Port=5432;Database=pixievisio;Username=postgres;Password=sql";
var connString = builder.Configuration.GetConnectionString("Default") ?? envConn ?? defaultConn;

// Try Postgres; fall back to SQLite if unreachable
bool useSqlite = false;
if (!string.IsNullOrWhiteSpace(connString))
{
    try
    {
        using var testConn = new NpgsqlConnection(connString);
        testConn.Open();
        testConn.Close();
        Console.WriteLine("Using PostgreSQL for storage.");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"Postgres not reachable ({ex.Message}). Falling back to SQLite.");
        useSqlite = true;
    }
}
else
{
    useSqlite = true;
}

if (useSqlite)
{
    var sqlitePath = Path.Combine(AppContext.BaseDirectory, "pixievisio.db");
    var sqliteConn = $"Data Source={sqlitePath}";
    builder.Services.AddDbContext<VisioDbContext>(options =>
        options.UseSqlite(sqliteConn));
}
else
{
    builder.Services.AddDbContext<VisioDbContext>(options =>
        options.UseNpgsql(connString));
}

var app = builder.Build();

app.UseCors();

// ensure DB exists (creates database/tables if not present)
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<VisioDbContext>();
    db.Database.EnsureCreated();

    // Ensure ModelId column exists (handles existing DBs created without ModelId)
    var conn = db.Database.GetDbConnection();
    try
    {
        conn.Open();
        if (db.Database.ProviderName != null && db.Database.ProviderName.Contains("Npgsql"))
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='nodes' AND lower(column_name)='modelid'";
            var cntObj = cmd.ExecuteScalar();
            var cnt = Convert.ToInt32(cntObj ?? 0);
            if (cnt == 0)
            {
                using var add = conn.CreateCommand();
                add.CommandText = "ALTER TABLE nodes ADD COLUMN \"ModelId\" text NOT NULL DEFAULT 'default'";
                add.ExecuteNonQuery();
            }

            using var idx = conn.CreateCommand();
            idx.CommandText = "CREATE INDEX IF NOT EXISTS ix_nodes_modelid ON nodes (\"ModelId\")";
            idx.ExecuteNonQuery();
        }
        else // assume SQLite
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "PRAGMA table_info('nodes')";
            using var reader = cmd.ExecuteReader();
            var found = false;
            while (reader.Read())
            {
                var name = reader["name"]?.ToString();
                if (!string.IsNullOrEmpty(name) && name.ToLower() == "modelid")
                {
                    found = true;
                    break;
                }
            }
            reader.Close();
            if (!found)
            {
                using var add = conn.CreateCommand();
                add.CommandText = "ALTER TABLE nodes ADD COLUMN ModelId TEXT DEFAULT 'default'";
                add.ExecuteNonQuery();
            }

            using var idx = conn.CreateCommand();
            idx.CommandText = "CREATE INDEX IF NOT EXISTS ix_nodes_modelid ON nodes (ModelId)";
            idx.ExecuteNonQuery();
        }
    }
    finally
    {
        conn.Close();
    }
}

// health
app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

// Save endpoint: accepts { modelId?: string, nodes: [{ id?, x, y, text }, ...] }
app.MapPost("/api/save", async (HttpRequest req, VisioDbContext db) =>
{
    try
    {
        var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var payload = await JsonSerializer.DeserializeAsync<SaveRequest>(req.Body, jsonOptions);
        if (payload == null || payload.Nodes == null) return Results.BadRequest("invalid payload");

        var modelId = string.IsNullOrWhiteSpace(payload.ModelId) ? "default" : payload.ModelId;

        // delete existing nodes for this model and insert new ones
        var existing = db.Nodes.Where(n => n.ModelId == modelId);
        db.Nodes.RemoveRange(existing);

        foreach (var el in payload.Nodes)
        {
            var id = string.IsNullOrWhiteSpace(el.Id) ? Guid.NewGuid().ToString() : el.Id!;
            var node = new Node { Id = id, ModelId = modelId, X = el.X, Y = el.Y, Text = el.Text ?? string.Empty };
            db.Nodes.Add(node);
        }

        await db.SaveChangesAsync();
        return Results.Ok(new { saved = true, modelId });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

// Load endpoint: /api/load?modelId=default
app.MapGet("/api/load", async (HttpRequest req, VisioDbContext db) =>
{
    try
    {
        var modelId = req.Query["modelId"].ToString();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = "default";

        var nodes = await db.Nodes
            .Where(n => n.ModelId == modelId)
            .Select(n => new { n.Id, n.X, n.Y, n.Text })
            .ToListAsync();

        return Results.Ok(new { nodes, modelId });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.Run("http://localhost:5000");

// DTOs used for deserialization from frontend
internal class SaveRequest
{
    public string? ModelId { get; set; }
    public List<NodeDto>? Nodes { get; set; }
}

internal class NodeDto
{
    public string? Id { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public string? Text { get; set; }
}