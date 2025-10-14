using Microsoft.EntityFrameworkCore;
using PixieVisio.Server.Models;

namespace PixieVisio.Server.Data
{
    public class VisioDbContext : DbContext
    {
        public VisioDbContext(DbContextOptions<VisioDbContext> options) : base(options) { }

        public DbSet<Node> Nodes => Set<Node>();
        public DbSet<Connection> Connections => Set<Connection>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Node>()
                .HasKey(n => n.Id);
            modelBuilder.Entity<Node>()
                .HasIndex(n => n.ModelId);

            modelBuilder.Entity<Connection>()
                .HasKey(c => c.Id);
            modelBuilder.Entity<Connection>()
                .HasIndex(c => c.ModelId);
            base.OnModelCreating(modelBuilder);
        }
    }
}
