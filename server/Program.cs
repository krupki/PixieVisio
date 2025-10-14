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
using System.Data.Common;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.WithOrigins("http://localhost:3000")
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

var sqlitePath = Path.Combine(AppContext.BaseDirectory, "pixievisio.db");
var sqliteConn = $"Data Source={sqlitePath}";
builder.Services.AddDbContext<VisioDbContext>(options =>
    options.UseSqlite(sqliteConn));
Console.WriteLine("Using SQLite for storage.");

var app = builder.Build();

app.UseCors();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<VisioDbContext>();
    db.Database.EnsureCreated();

    var conn = db.Database.GetDbConnection();
    try
    {
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA table_info('nodes')";
        using var reader = cmd.ExecuteReader();
        var foundModelId = false;
        var foundColor = false;
        while (reader.Read())
        {
            var name = reader["name"]?.ToString();
            if (!string.IsNullOrEmpty(name))
            {
                if (name.ToLower() == "modelid") foundModelId = true;
                if (name.ToLower() == "color") foundColor = true;
            }
        }
        reader.Close();

        if (!foundModelId)
        {
            using var add = conn.CreateCommand();
            add.CommandText = "ALTER TABLE nodes ADD COLUMN ModelId TEXT DEFAULT 'default'";
            add.ExecuteNonQuery();
        }

        if (!foundColor)
        {
            using var addColor = conn.CreateCommand();
            addColor.CommandText = "ALTER TABLE nodes ADD COLUMN Color TEXT DEFAULT '#f4f4f4'";
            addColor.ExecuteNonQuery();
        }

        using var connTableCmd = conn.CreateCommand();
        connTableCmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS connections (
                Id TEXT PRIMARY KEY,
                ModelId TEXT NOT NULL DEFAULT 'default',
                FromNodeId TEXT NOT NULL,
                ToNodeId TEXT NOT NULL,
                Style TEXT NOT NULL DEFAULT 'solid',
                Color TEXT NOT NULL DEFAULT '#333333',
                Width INTEGER NOT NULL DEFAULT 3,
                Label TEXT NOT NULL DEFAULT ''
            )";
        connTableCmd.ExecuteNonQuery();

        using var idx = conn.CreateCommand();
        idx.CommandText = "CREATE INDEX IF NOT EXISTS ix_nodes_modelid ON nodes (ModelId)";
        idx.ExecuteNonQuery();

        using var connIdx = conn.CreateCommand();
        connIdx.CommandText = "CREATE INDEX IF NOT EXISTS ix_connections_modelid ON connections (ModelId)";
        connIdx.ExecuteNonQuery();
    }
    finally
    {
        conn.Close();
    }
}

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapPost("/api/save", async (HttpRequest req, VisioDbContext db) =>
{
    try
    {
        var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var payload = await JsonSerializer.DeserializeAsync<SaveRequest>(req.Body, jsonOptions);
        if (payload == null || payload.Nodes == null) return Results.BadRequest("invalid payload");

        var modelId = string.IsNullOrWhiteSpace(payload.ModelId) ? "default" : payload.ModelId;

        var existing = db.Nodes.Where(n => n.ModelId == modelId);
        db.Nodes.RemoveRange(existing);

        foreach (var el in payload.Nodes)
        {
            var id = string.IsNullOrWhiteSpace(el.Id) ? Guid.NewGuid().ToString() : el.Id!;
            var node = new Node
            {
                Id = id,
                ModelId = modelId,
                X = el.X,
                Y = el.Y,
                Text = el.Text ?? string.Empty,
                Color = el.Color ?? "#f4f4f4"
            };
            db.Nodes.Add(node);
        }

        // Verbindungen speichern
        var existingConnections = db.Connections.Where(c => c.ModelId == modelId);
        db.Connections.RemoveRange(existingConnections);

        Console.WriteLine($"Connections in payload: {payload.Connections?.Count ?? 0}");
        if (payload.Connections != null)
        {
            Console.WriteLine($"Processing {payload.Connections.Count} connections");
            foreach (var conn in payload.Connections)
            {
                var connectionId = string.IsNullOrWhiteSpace(conn.Id) ? Guid.NewGuid().ToString() : conn.Id!;
                Console.WriteLine($"Creating connection: {conn.FromNodeId} -> {conn.ToNodeId}");
                var connection = new Connection
                {
                    Id = connectionId,
                    ModelId = modelId,
                    FromNodeId = conn.FromNodeId ?? string.Empty,
                    ToNodeId = conn.ToNodeId ?? string.Empty,
                    Style = conn.Style ?? "solid",
                    Color = conn.Color ?? "#333333",
                    Width = conn.Width > 0 ? conn.Width : 3,
                    Label = conn.Label ?? string.Empty
                };
                db.Connections.Add(connection);
            }
        }

        await db.SaveChangesAsync();
        return Results.Ok(new { saved = true, modelId });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.MapGet("/api/load", async (HttpRequest req, VisioDbContext db) =>
{
    try
    {
        var modelId = req.Query["modelId"].ToString();
        if (string.IsNullOrWhiteSpace(modelId)) modelId = "default";

        var nodes = await db.Nodes
            .Where(n => n.ModelId == modelId)
            .Select(n => new { n.Id, n.X, n.Y, n.Text, n.Color })
            .ToListAsync();

        var connections = await db.Connections
            .Where(c => c.ModelId == modelId)
            .Select(c => new { c.Id, c.FromNodeId, c.ToNodeId, c.Style, c.Color, c.Width, c.Label })
            .ToListAsync();

        return Results.Ok(new { nodes, connections, modelId });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

// Verbindung zwischen zwei Nodes erstellen
app.MapPost("/api/connections", async (HttpRequest req, VisioDbContext db) =>
{
    try
    {
        var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        var payload = await JsonSerializer.DeserializeAsync<CreateConnectionRequest>(req.Body, jsonOptions);
        if (payload == null) return Results.BadRequest("invalid payload");

        var modelId = string.IsNullOrWhiteSpace(payload.ModelId) ? "default" : payload.ModelId;

        // Prüfen ob beide Nodes existieren
        var fromExists = await db.Nodes.AnyAsync(n => n.Id == payload.FromNodeId && n.ModelId == modelId);
        var toExists = await db.Nodes.AnyAsync(n => n.Id == payload.ToNodeId && n.ModelId == modelId);

        if (!fromExists || !toExists)
            return Results.BadRequest("One or both nodes not found");

        var connection = new Connection
        {
            Id = Guid.NewGuid().ToString(),
            ModelId = modelId,
            FromNodeId = payload.FromNodeId!,
            ToNodeId = payload.ToNodeId!,
            Style = payload.Style ?? "solid",
            Color = payload.Color ?? "#333333",
            Width = payload.Width > 0 ? payload.Width : 3,
            Label = payload.Label ?? string.Empty
        };

        db.Connections.Add(connection);
        await db.SaveChangesAsync();

        return Results.Ok(new { connection.Id, connection.FromNodeId, connection.ToNodeId, connection.Style, connection.Color, connection.Width, connection.Label });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

// Verbindung löschen
app.MapDelete("/api/connections/{id}", async (string id, VisioDbContext db) =>
{
    try
    {
        var connection = await db.Connections.FindAsync(id);
        if (connection == null) return Results.NotFound();

        db.Connections.Remove(connection);
        await db.SaveChangesAsync();
        return Results.Ok(new { deleted = true });
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message);
    }
});

app.Run("http://localhost:5000");

internal class SaveRequest
{
    public string? ModelId { get; set; }
    public List<NodeDto>? Nodes { get; set; }
    public List<ConnectionDto>? Connections { get; set; }
}

internal class NodeDto
{
    public string? Id { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public string? Text { get; set; }
    public string? Color { get; set; }
}

internal class ConnectionDto
{
    public string? Id { get; set; }
    public string? FromNodeId { get; set; }
    public string? ToNodeId { get; set; }
    public string? Style { get; set; }
    public string? Color { get; set; }
    public int Width { get; set; }
    public string? Label { get; set; }
}

internal class CreateConnectionRequest
{
    public string? ModelId { get; set; }
    public string? FromNodeId { get; set; }
    public string? ToNodeId { get; set; }
    public string? Style { get; set; }
    public string? Color { get; set; }
    public int Width { get; set; }
    public string? Label { get; set; }
}